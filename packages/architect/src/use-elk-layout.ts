import { useEffect, useMemo, useRef, useState } from "react";
import type { ArchitectureGraph } from "@crystal/core";
import { elkAutoLayout, type ElkRoute } from "./elk-layout.js";
import { autoLayoutFitted } from "./layout.js";

type Size = { width: number; height: number };
interface PublishedLayout {
  graph: ArchitectureGraph;
  dimsKey: string;
  aspectRatioKey: string;
  laid: ArchitectureGraph;
  routes: ReadonlyMap<string, ElkRoute> | null;
  /**
   * Bumped when a solve lands for a graph id that had none yet — the moment
   * the canvas should reframe. Same-level refinements (measured dims) keep
   * the revision so the viewport is not yanked while the user reads/pans.
   */
  revision: number;
}

/** A rebuilt Map with equal values must not restart the asynchronous engine. */
function dimensionsKey(dims: ReadonlyMap<string, Size> | null): string {
  if (!dims) return "";
  return JSON.stringify(
    [...dims].sort(([a], [b]) => a.localeCompare(b)).map(([id, size]) => [
      id,
      size.width,
      size.height,
    ]),
  );
}

/**
 * Instant dagre first paint followed by compound-aware ELK geometry.
 *
 * ELK runs in-process but remains asynchronous. The serial prevents an older
 * solve from winning after a projection/dimension change; same-level stale
 * serving avoids a visible jump back to dagre while measurements settle.
 */
export function useElkLayout(
  graph: ArchitectureGraph | null,
  dims: ReadonlyMap<string, Size> | null,
  aspectRatio = 1.7,
): {
  laid: ArchitectureGraph | null;
  routes: ReadonlyMap<string, ElkRoute> | null;
  revision: number;
} {
  const dimsKey = dimensionsKey(dims);
  const aspectRatioKey = Number.isFinite(aspectRatio) ? aspectRatio.toFixed(3) : "1.700";
  const dimsRef = useRef(dims);
  dimsRef.current = dims;
  const serial = useRef(0);
  const warned = useRef(false);
  const [published, setPublished] = useState<PublishedLayout | null>(null);

  const fallback = useMemo(
    () =>
      graph
        ? autoLayoutFitted(graph, {
            mode: "flow",
            reserve: dimsRef.current ?? undefined,
          })
        : null,
    [graph, dimsKey],
  );

  useEffect(() => {
    const token = ++serial.current;
    if (!graph || !fallback) return;
    const inputDims = dimsRef.current;
    const revisionFor = (previous: PublishedLayout | null): number =>
      previous == null ? 1 : previous.graph.id === graph.id ? previous.revision : previous.revision + 1;
    void elkAutoLayout(graph, {
      dims: inputDims ?? undefined,
      aspectRatio: Number(aspectRatioKey),
    })
      .then((result) => {
        if (serial.current !== token) return;
        setPublished((previous) => ({
          graph,
          dimsKey,
          aspectRatioKey,
          laid: result.graph,
          routes: result.routes,
          revision: revisionFor(previous),
        }));
      })
      .catch((error: unknown) => {
        if (serial.current !== token) return;
        if (!warned.current) {
          warned.current = true;
          console.warn("ELK architecture layout failed; keeping the dagre fallback", error);
        }
        setPublished((previous) => ({
          graph,
          dimsKey,
          aspectRatioKey,
          laid: fallback,
          routes: null,
          revision: revisionFor(previous),
        }));
      });
    return () => {
      // Input changes increment again in the next effect; unmounts need this
      // cleanup so a completed solve never publishes into a retired hook.
      if (serial.current === token) serial.current += 1;
    };
  }, [graph, dimsKey, aspectRatioKey, fallback]);

  if (!graph || !fallback) return { laid: null, routes: null, revision: 0 };
  if (
    published?.graph === graph &&
    published.dimsKey === dimsKey &&
    published.aspectRatioKey === aspectRatioKey
  ) {
    return { laid: published.laid, routes: published.routes, revision: published.revision };
  }
  // Measurements and projected content can change without changing C4
  // altitude. Keep that level's last solved geometry until its replacement
  // arrives, but never flash geometry from another level.
  if (published?.graph.id === graph.id) {
    return { laid: published.laid, routes: published.routes, revision: published.revision };
  }
  return { laid: fallback, routes: null, revision: published?.revision ?? 0 };
}

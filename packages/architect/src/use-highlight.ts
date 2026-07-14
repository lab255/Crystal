import { useCallback, useMemo } from "react";
import { formatHighlightSel, parseHighlightSel, type HighlightRef } from "@crystal/core";
import { useHighlight, useHighlightUpdate, useNav, useNavUpdate } from "@crystal/client";

/**
 * Cross-view highlight, architect side. One shared identity (`HighlightRef`
 * in `@crystal/core`) with two lifetimes:
 *
 *   hover  — published to the client highlight store on mouseover; every
 *            surface lights up matching elements live.
 *   pinned — a click, stored as `architect.sel` in the deep link; persistent,
 *            shareable, restored on reload.
 *
 * Views call `useViewHighlight(viewId)` and match their elements with
 * `matchHighlight`; `hlClass` turns matches into the shared css classes
 * (architect.css). `highlightAttrs` stamps the structured hierarchy onto the
 * DOM so selectors, tests and devtools can traverse it.
 */
export function useViewHighlight(view: string): {
  /** Live hover from any surface (including this one — check `hoverSource`). */
  hover: HighlightRef | null;
  /** View id that published the current hover. */
  hoverSource: string | null;
  /** Deep-linked pinned highlight (`sel` param), if any. */
  pinned: HighlightRef | null;
  /** Publish (`ref`) or clear (`null`) this view's hover. */
  setHover: (ref: HighlightRef | null) => void;
  /** Pin a highlight into the deep link, or clear it with `null`. */
  pin: (ref: HighlightRef | null) => void;
} {
  const hover = useHighlight((s) => s.hover);
  const hoverSource = useHighlight((s) => s.source);
  const publish = useHighlightUpdate();
  const sel = useNav((l) => l.architect?.sel);
  const updateNav = useNavUpdate();

  const pinned = useMemo(() => parseHighlightSel(sel), [sel]);
  const setHover = useCallback(
    (ref: HighlightRef | null) => publish(ref, view),
    [publish, view],
  );
  const pin = useCallback(
    (ref: HighlightRef | null) => {
      updateNav({ architect: { sel: ref ? formatHighlightSel(ref) : null } });
    },
    [updateNav],
  );

  return { hover, hoverSource, pinned, setHover, pin };
}

/** Combine hover/pin match results into the shared highlight css classes. */
export function hlClass(
  hover: "exact" | "kin" | null,
  pinned: "exact" | "kin" | null,
): string {
  const parts: string[] = [];
  if (hover === "exact") parts.push("hl-hover");
  else if (hover === "kin") parts.push("hl-kin");
  if (pinned === "exact") parts.push("hl-pin");
  else if (pinned === "kin" && hover === null) parts.push("hl-kin");
  return parts.join(" ");
}

/**
 * Structured hierarchy annotation for a rendered element: every facet of its
 * identity plus its containment chain, as data attributes. This is the DOM
 * face of the highlight system — stable hooks for css, tests and tooling.
 */
export function highlightAttrs(ref: HighlightRef): Record<string, string> {
  const attrs: Record<string, string> = {};
  if (ref.node) attrs["data-hl-node"] = ref.node;
  if (ref.nodePath?.length) attrs["data-hl-node-path"] = ref.nodePath.join("/");
  if (ref.module) attrs["data-hl-module"] = ref.module;
  if (ref.file) attrs["data-hl-file"] = ref.file;
  if (ref.symbol) attrs["data-hl-symbol"] = ref.symbol;
  return attrs;
}

// The shared right-click vocabulary that used to live here (`crossViewEntries`)
// is now `symbolMenuEntries`/`useSymbolMenu` in @crystal/client, so every mode
// (not just architect) builds the same function/symbol context menu.

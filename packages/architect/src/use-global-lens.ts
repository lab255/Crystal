import { useMemo } from "react";
import {
  parseLensParam,
  type LensMatcher,
  type LensMembership,
  type LensSpec,
  type WorkspaceFacet,
} from "@crystal/core";
import { useLens } from "@crystal/client";

const NO_TAGS: string[] = [];

export interface GlobalLens {
  /** Parsed spec of the top-level `lens` deep-link param (null = no lens). */
  spec: LensSpec | null;
  /** Tags of a `tags` lens — [] for diff/facet/none. Feeds the historical tag pipeline. */
  tags: string[];
  /** True for diff / saved-facet specs, whose membership the client lens store resolves. */
  global: boolean;
  /** Resolved membership of a diff/facet lens (null while loading, stale, errored, or tags). */
  membership: LensMembership | null;
  /** Matcher over that membership (null under the same conditions). */
  matcher: LensMatcher | null;
  /** The store finished (ready or error) resolving THIS param. */
  settled: boolean;
  /** Saved workspace facets — names for `facet:` lens chips. */
  facets: WorkspaceFacet[];
}

/**
 * The architect views' bridge to the global lens. Tag lenses keep their
 * historical in-view resolution (code index + systems overview); diff and
 * saved-facet lenses take the membership the client lens store resolved
 * (changed files / the facet's saved spec). Membership is gated on the store
 * actually holding *this* param, so a half-switched lens never leaks the
 * previous lens's members into the canvas.
 */
export function useGlobalLens(lensParam: string | null): GlobalLens {
  const spec = useMemo(() => parseLensParam(lensParam), [lensParam]);
  const global = spec != null && spec.kind !== "tags";
  const storeKey = useLens((s) => s.key);
  const status = useLens((s) => s.status);
  const storeMembership = useLens((s) => s.membership);
  const storeMatcher = useLens((s) => s.matcher);
  const facets = useLens((s) => s.facets);
  // Store keys are `${ws}|${raw}` — match on the raw param.
  const current =
    global && storeKey != null && storeKey.slice(storeKey.indexOf("|") + 1) === lensParam;
  const ready = current && status === "ready";
  return {
    spec,
    tags: spec?.kind === "tags" ? spec.tags : NO_TAGS,
    global,
    membership: ready ? storeMembership : null,
    matcher: ready ? storeMatcher : null,
    settled: current && (status === "ready" || status === "error"),
    facets,
  };
}

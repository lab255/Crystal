import { useMemo } from "react";
import { deriveNeedsYou, type NeedsYou } from "@crystal/core";
import { useAgents, useWorkspace } from "./provider.js";

/**
 * "Needs you" for the active workspace — open questions + unrecovered
 * recoverable failures. The policy is pure in @crystal/core (needs-you.ts);
 * this hook just binds it to the stores. Components that only need the badge
 * COUNT should not use this hook — select `countOpenQuestions` /
 * `countUnrecoveredFailures` (primitives) instead so they don't re-render on
 * every stream event (see CrystalShell).
 */

export type { NeedsYou, NeedsYouQuestion } from "@crystal/core";

const EMPTY_PROJECTS: never[] = [];

export function useNeedsYou(): NeedsYou {
  const projects = useWorkspace((s) => s.info?.projects ?? EMPTY_PROJECTS);
  const runs = useAgents((s) => s.runs);
  // Derivation stays outside the selectors (zustand v5 stable-reference rule).
  return useMemo(() => deriveNeedsYou(projects, runs), [projects, runs]);
}

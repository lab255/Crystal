import { useEffect, useRef } from "react";
import type { AgentRun } from "@crystal/core";

/**
 * Follow a selected conversation when a queued delivery grows a successor
 * turn: a new turn resumed from the *selected tip* advances the selection
 * with it. Selecting an older turn on purpose is respected — it already had
 * a successor when selected, so it never auto-advances away.
 *
 * Extracted from RunsPane/SessionsTab, which had drifted toward two copies
 * of this effect; every run-list + RunSurface pairing uses this hook.
 */
export function useFollowChain(
  runs: readonly AgentRun[],
  selectedRunId: string | null,
  onSelect: (id: string) => void,
): void {
  const lastSelected = useRef<string | null>(null);
  const hadSuccessor = useRef(false);
  useEffect(() => {
    // No baseline from an unloaded list: the store starts empty, and a
    // deep-linked older turn would otherwise record "no successor" before
    // refresh() lands — then bounce to the tip the moment runs arrive.
    if (runs.length === 0) return;
    const successor = selectedRunId
      ? runs.find((candidate) => candidate.resumedFromRunId === selectedRunId)
      : undefined;
    if (selectedRunId !== lastSelected.current) {
      lastSelected.current = selectedRunId;
      hadSuccessor.current = successor != null;
      return;
    }
    if (!selectedRunId || hadSuccessor.current || !successor) return;
    onSelect(successor.id);
  }, [runs, selectedRunId, onSelect]);
}

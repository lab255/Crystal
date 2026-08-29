import { useCallback, useMemo } from "react";
import {
  partitionQuestionRows,
  unrecoveredFailures,
  type AgentRun,
} from "@crystal/core";
import { EMPTY_QUESTIONS, EMPTY_RUNS, type FleetQuestion } from "./fleet-store.js";
import { wsKey } from "./fleet-client.js";
import { attentionJump, type AttentionTarget } from "./attention-policy.js";

export type { AttentionTarget } from "./attention-policy.js";
import { useCrystal, useFleet, useFleetConnections } from "./provider.js";

/**
 * Cross-workspace "needs you" — the fleet-wide counterpart of `useNeedsYou`
 * (which stays scoped to the active workspace). One row per open workspace on
 * every connection, aggregating the same two signals the per-workspace policy
 * defines (open questions + unrecovered recoverable failures, @crystal/core
 * needs-you.ts): the shell's global pill and the attention notifier both read
 * this, so what gets counted, listed and announced can never drift apart.
 */
export interface WorkspaceNeedsYou {
  sid: string;
  ws: string;
  /** Compound fleet key (`wsKey(sid, ws)`). */
  key: string;
  name: string;
  /** Server label when several bridges are connected; null on a lone fleet. */
  serverLabel: string | null;
  /** Full fleet run snapshot, used by transition consumers beyond needs-you. */
  runs: AgentRun[];
  /** Every open row, including stale questions for inbox surfaces. */
  questions: FleetQuestion[];
  actionableQuestions: FleetQuestion[];
  staleQuestions: FleetQuestion[];
  failures: AgentRun[];
  count: number;
  /** False until the workspace's board / run list has been read at least
   *  once — "unknown" and "empty" are different to the notifier's seeding. */
  questionsRead: boolean;
  runsRead: boolean;
}

export interface FleetNeedsYou {
  /** Every open workspace, waiting or not (the pill filters, the notifier seeds). */
  rows: WorkspaceNeedsYou[];
  /** Total items waiting across the fleet. */
  count: number;
}

export function useFleetNeedsYou(): FleetNeedsYou {
  const connections = useFleetConnections();
  const runsByWs = useFleet((s) => s.runsByWs);
  const runsLoadedByWs = useFleet((s) => s.runsLoadedByWs);
  const questionsByWs = useFleet((s) => s.questionsByWs);
  // Derivation stays outside the selectors (zustand v5 stable-reference rule).
  return useMemo(() => {
    const multiServer = connections.length > 1;
    const rows: WorkspaceNeedsYou[] = [];
    let count = 0;
    for (const c of connections) {
      for (const w of c.workspaces) {
        const key = wsKey(c.sid, w.id);
        const questions = questionsByWs[key] ?? EMPTY_QUESTIONS;
        const partitioned = partitionQuestionRows(questions);
        const runs = runsByWs[key];
        const runsRead = runsLoadedByWs[key] === true;
        const failures = runsRead ? unrecoveredFailures(runs ?? EMPTY_RUNS) : EMPTY_RUNS;
        rows.push({
          sid: c.sid,
          ws: w.id,
          key,
          name: w.name,
          serverLabel: multiServer ? c.label : null,
          runs: runs ?? EMPTY_RUNS,
          questions,
          actionableQuestions: partitioned.actionable,
          staleQuestions: partitioned.stale,
          failures,
          count: partitioned.actionable.length + failures.length,
          questionsRead: questionsByWs[key] !== undefined,
          runsRead,
        });
        count += partitioned.actionable.length + failures.length;
      }
    }
    return { rows, count };
  }, [connections, runsByWs, runsLoadedByWs, questionsByWs]);
}

/**
 * Jump to a notification item from any mode — the policy is `attentionJump`
 * (attention-policy.ts): in-project thread from a project mode, the Overview's
 * cross-project thread when already in mission control, and coordinator items
 * always on their program thread.
 */
export function useAttentionJump(): (target: AttentionTarget) => void {
  const { selectWorkspace, navStore } = useCrystal();
  return useCallback(
    (target: AttentionTarget) => {
      const jump = attentionJump(navStore.getState().link.mode, target);
      if (jump.select) selectWorkspace(jump.select.sid, jump.select.ws);
      navStore.getState().update(jump.patch);
    },
    [selectWorkspace, navStore],
  );
}

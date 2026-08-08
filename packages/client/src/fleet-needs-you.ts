import { useCallback, useMemo } from "react";
import {
  formatWsRef,
  unrecoveredFailures,
  type AgentRun,
  type NeedsYouQuestion,
} from "@crystal/core";
import { EMPTY_QUESTIONS, EMPTY_RUNS } from "./fleet-store.js";
import { wsKey } from "./fleet-client.js";
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
  questions: NeedsYouQuestion[];
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
        const runs = runsByWs[key];
        const failures = runs === undefined ? EMPTY_RUNS : unrecoveredFailures(runs);
        rows.push({
          sid: c.sid,
          ws: w.id,
          key,
          name: w.name,
          serverLabel: multiServer ? c.label : null,
          runs: runs ?? EMPTY_RUNS,
          questions,
          failures,
          count: questions.length + failures.length,
          questionsRead: questionsByWs[key] !== undefined,
          runsRead: runs !== undefined,
        });
        count += questions.length + failures.length;
      }
    }
    return { rows, count };
  }, [connections, runsByWs, questionsByWs]);
}

/** One notification item, addressed well enough to jump to it from anywhere. */
export type AttentionTarget =
  | { kind: "question"; sid: string; ws: string; question: NeedsYouQuestion }
  | { kind: "failure"; sid: string; ws: string; run: AgentRun }
  | { kind: "run"; sid: string; ws: string; run: AgentRun }
  | { kind: "workflow"; sid: string; ws: string; workflowId: string };

/**
 * Jump to a notification item from any mode: focus its (server, workspace)
 * pair and deep-link the orchestrator to the task board, run review, or
 * workflow view. Same shape as the overview card's navigation actions.
 */
export function useAttentionJump(): (target: AttentionTarget) => void {
  const { selectWorkspace, navStore } = useCrystal();
  return useCallback(
    (target: AttentionTarget) => {
      selectWorkspace(target.sid, target.ws);
      const ws = formatWsRef(target.sid, target.ws);
      if (target.kind === "question") {
        navStore.getState().update({
          ws,
          mode: "orchestrate",
          orchestrate: {
            tab: "board",
            project: target.question.projectPath,
            task: target.question.taskId,
          },
        });
      } else if (target.kind === "workflow") {
        navStore.getState().update({
          ws,
          mode: "orchestrate",
          orchestrate: { tab: "workflows", workflow: target.workflowId },
        });
      } else {
        navStore.getState().update({
          ws,
          mode: "orchestrate",
          orchestrate: { tab: "runs", run: target.run.id },
        });
      }
    },
    [selectWorkspace, navStore],
  );
}

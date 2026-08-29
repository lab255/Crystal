import {
  groupRunsByManager,
  sessionDisplayStatus,
  sessionHeadline,
  sessionLatestActivity,
  sessionSubtreeCost,
  sessionWorkflowId,
  type AgentRun,
  type RunNode,
  type SessionNamingContext,
} from "@crystal/core";
import { humanRunFailure } from "./transcript-items.js";

/**
 * The ONE status dot a thread row shows, in precedence order. Derived from
 * core's {@link sessionDisplayStatus} (needs-you > working > failed > idle)
 * with unread overlaid on idle only: a working thread already announces
 * itself, and needs-input/failed clear by acting, never by looking.
 */
export type ThreadIndicator = "needs-input" | "running" | "failed" | "unread" | "idle";

const INDICATOR_RANK: Record<ThreadIndicator, number> = {
  "needs-input": 0,
  running: 1,
  failed: 2,
  unread: 3,
  idle: 4,
};

/** One rail row — a resume chain with its nested workers, summarized. */
export interface ThreadSummary {
  /** Thread identity: the chain-root run id (stable across resumes). */
  id: string;
  node: RunNode;
  title: string;
  indicator: ThreadIndicator;
  /** Subtree spend; null = no turn has a readable cost (NOT zero). */
  costUsd: number | null;
  /** Newest activity stamp in the subtree (ISO). */
  lastActivity: string;
  projectId: string | null;
  pinned: boolean;
  sid?: string;
  ws?: string;
}

/** The terminal outcome shown consistently by the transcript and rail tooltip. */
export function threadFailureTitle(node: RunNode): string | null {
  const failed: AgentRun[] = [];
  const walk = (current: RunNode) => {
    failed.push(...current.turns.filter((turn) =>
      turn.status === "failed" || turn.status === "cancelled"));
    current.workers.forEach(walk);
  };
  walk(node);
  const turn = failed.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (!turn) return null;
  const outcome = turn.status === "cancelled" ? "Turn cancelled" : "Turn failed";
  const reason = humanRunFailure(turn.resultText ?? "");
  return reason ? `${outcome} — ${reason}` : outcome;
}

/** Rail section: one project's threads (null id = runs outside any board). */
export interface ThreadGroup {
  projectId: string | null;
  name: string;
  threads: ThreadSummary[];
  sid?: string;
  ws?: string;
}

export interface ThreadModelInput {
  scope?: { sid: string; ws: string };
  /** The workspace's run list (agent store order — newest first). */
  runs: readonly AgentRun[];
  /** Run ids waiting on the operator (attention policy + parked permissions). */
  attention: ReadonlySet<string>;
  /** Per-thread last-seen stamps (ISO), keyed by thread id. */
  lastSeen: Readonly<Record<string, string>>;
  pins: ReadonlySet<string>;
  /** Rail text filter — matches the thread title. */
  find?: string;
  projectNameOf?: (projectId: string) => string | null | undefined;
  namingContext?: SessionNamingContext;
}

/** Thread identity for a session node: its opening turn's run id. */
export function threadIdOf(node: RunNode): string {
  return node.turns[0]!.id;
}

export function threadIndicator(
  node: RunNode,
  attention: ReadonlySet<string>,
  lastSeenAt: string | undefined,
): ThreadIndicator {
  const status = sessionDisplayStatus(node, attention);
  if (status === "needs-you") return "needs-input";
  if (status === "working") return "running";
  if (status === "failed") return "failed";
  return lastSeenAt == null || sessionLatestActivity(node) > lastSeenAt ? "unread" : "idle";
}

/** The chain's board attribution: the first turn that carries a projectId. */
function threadProjectId(node: RunNode): string | null {
  return node.turns.find((turn) => turn.projectId)?.projectId ?? null;
}

/**
 * Fold the run list into the rail's grouped thread sections. Within a group:
 * pinned first, then indicator precedence, then latest activity (newest
 * first). Groups order by their most urgent thread, "Ad hoc" (no board) last
 * among equals.
 */
export function buildThreadGroups(input: ThreadModelInput): ThreadGroup[] {
  const find = input.find?.trim().toLowerCase();
  const summaries: ThreadSummary[] = [];
  for (const node of groupRunsByManager([...input.runs])) {
    const id = threadIdOf(node);
    const title = sessionHeadline(node, input.namingContext);
    if (find && !title.toLowerCase().includes(find)) continue;
    summaries.push({
      id,
      node,
      title,
      indicator: threadIndicator(node, input.attention, input.lastSeen[id]),
      costUsd: sessionSubtreeCost(node),
      lastActivity: sessionLatestActivity(node),
      projectId: threadProjectId(node),
      pinned: input.pins.has(id),
      ...input.scope,
    });
  }

  summaries.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    const rank = INDICATOR_RANK[a.indicator] - INDICATOR_RANK[b.indicator];
    if (rank !== 0) return rank;
    return b.lastActivity.localeCompare(a.lastActivity);
  });

  const groups = new Map<string, ThreadGroup>();
  for (const summary of summaries) {
    const workflowId = summary.projectId ? null : sessionWorkflowId(summary.node);
    const key = summary.projectId ? `project:${summary.projectId}`
      : workflowId ? `workflow:${workflowId}` : "ad-hoc";
    let group = groups.get(key);
    if (!group) {
      group = {
        projectId: summary.projectId,
        name: summary.projectId
          ? (input.projectNameOf?.(summary.projectId) ?? summary.projectId)
          : workflowId
            ? (input.namingContext?.workflowNameOf?.(workflowId) ?? "Workflows")
            : "Ad hoc",
        threads: [],
        ...input.scope,
      };
      groups.set(key, group);
    }
    group.threads.push(summary);
  }
  // Insertion order already follows each group's most urgent thread (the
  // summaries are sorted), so the map's order is the display order.
  return [...groups.values()];
}

/**
 * Apply the rail's find filter to already-built groups (title match, empty
 * groups dropped). Kept separate from the fold so selection can resolve
 * against the UNFILTERED groups — a stale filter must dim the rail, never
 * make a jumped-to thread unresolvable.
 */
export function filterThreadGroups(
  groups: readonly ThreadGroup[],
  find: string | null | undefined,
): ThreadGroup[] {
  const needle = find?.trim().toLowerCase();
  if (!needle) return [...groups];
  const out: ThreadGroup[] = [];
  for (const group of groups) {
    const threads = group.threads.filter((t) => t.title.toLowerCase().includes(needle));
    if (threads.length) out.push({ ...group, threads });
  }
  return out;
}

/**
 * Resolve a `threads.thread` deep-link value — any run id in a chain — to its
 * thread. Old `?run=` links point at arbitrary turns; the rail thinks in
 * chain roots.
 */
export function threadForRunId(
  groups: readonly ThreadGroup[],
  runId: string | null | undefined,
): ThreadSummary | null {
  if (!runId) return null;
  for (const group of groups) {
    for (const thread of group.threads) {
      const inChain = (node: RunNode): boolean =>
        node.turns.some((turn) => turn.id === runId) || node.workers.some(inChain);
      if (inChain(thread.node)) return thread;
    }
  }
  return null;
}

import {
  MANAGER_PREAMBLE,
  groupRunsByManager,
  programIdOfRun,
  sessionIsWorking,
  sessionLatestActivity,
  type AgentRun,
  type HubQuestion,
  type Program,
  type Workflow,
} from "@crystal/core";
import { chainOf, wsKey } from "@crystal/client";
import {
  buildThreadGroups,
  threadIndicator,
  type ThreadIndicator,
  type ThreadSummary,
} from "../thread-model.js";
import { threadReadKey } from "../thread-unread.js";

export type OverviewThreadRef =
  | { kind: "workspace"; sid: string; ws: string; threadId: string }
  | { kind: "program"; programId: string };

export function formatOverviewThreadId(ref: OverviewThreadRef): string {
  return ref.kind === "program"
    ? `program:${ref.programId}`
    : `ws:${ref.sid}/${ref.ws}/${ref.threadId}`;
}

export function parseOverviewThreadId(id: string): OverviewThreadRef | null {
  if (id.startsWith("program:")) {
    const programId = id.slice(8);
    return programId ? { kind: "program", programId } : null;
  }
  if (!id.startsWith("ws:")) return null;
  const value = id.slice(3);
  const first = value.indexOf("/");
  const last = value.lastIndexOf("/");
  if (first <= 0 || last <= first + 1 || last === value.length - 1) return null;
  return {
    kind: "workspace",
    sid: value.slice(0, first),
    ws: value.slice(first + 1, last),
    threadId: value.slice(last + 1),
  };
}

export interface OverviewModelInput {
  connections: readonly {
    sid: string;
    label: string;
    state: string;
    workspaces: readonly { id: string; name: string }[];
  }[];
  runsByWs: Record<string, AgentRun[]>;
  workflowsByWs: Record<string, Workflow[]>;
  attentionByWs: Record<string, Set<string>>;
  programs: readonly Program[];
  hubRuns: readonly AgentRun[];
  hubSid: string;
  programQuestions: Record<string, HubQuestion[]>;
  lastSeen: Record<string, string>;
  pins: Set<string>;
  filter: "managers" | "all";
  find?: string;
}

export interface OverviewThread {
  id: string;
  ref: OverviewThreadRef;
  readKey: string;
  title: string;
  indicator: ThreadIndicator;
  lastActivity: string | null;
  costUsd: number | null;
  pinned: boolean;
  summary?: ThreadSummary;
  program?: Program;
  workflow?: Workflow | null;
  live: boolean;
  workspaceName?: string;
  serverLabel?: string | null;
}

export type OverviewSection =
  | { kind: "coordinator"; sid: string; serverLabel: string | null; threads: OverviewThread[] }
  | {
      kind: "workspace";
      sid: string;
      ws: string;
      key: string;
      name: string;
      serverLabel: string | null;
      offline: boolean;
      threads: OverviewThread[];
    };

/** The program manager's current chain, or its retained retired history. */
export function programChain(program: Program, hubRuns: readonly AgentRun[]): AgentRun[] {
  const mine = hubRuns.filter((run) => programIdOfRun(run) === program.id);
  if (!mine.length) return [];
  const anchor =
    (program.managerRunId ? mine.find((run) => run.id === program.managerRunId) : null) ?? mine[0]!;
  return chainOf(mine, anchor);
}

const rank: Record<ThreadIndicator, number> = {
  "needs-input": 0,
  running: 1,
  failed: 2,
  unread: 3,
  idle: 4,
};

function sortThreads(threads: OverviewThread[]): void {
  threads.sort((a, b) =>
    a.pinned !== b.pinned
      ? a.pinned ? -1 : 1
      : rank[a.indicator] !== rank[b.indicator]
        ? rank[a.indicator] - rank[b.indicator]
        : (b.lastActivity ?? "").localeCompare(a.lastActivity ?? ""),
  );
}

export function buildOverviewSections(input: OverviewModelInput): OverviewSection[] {
  const multiServer = input.connections.length > 1;
  const needle = input.find?.trim().toLowerCase();
  const coordinator: OverviewSection = {
    kind: "coordinator",
    sid: input.hubSid,
    serverLabel: multiServer
      ? input.connections.find((connection) => connection.sid === input.hubSid)?.label ?? null
      : null,
    threads: [],
  };

  for (const program of input.programs) {
    const chain = programChain(program, input.hubRuns);
    const readKey = threadReadKey(formatOverviewThreadId({ kind: "program", programId: program.id }));
    if (needle && !program.name.toLowerCase().includes(needle)) continue;
    const node = chain.length ? groupRunsByManager(chain)[0] ?? null : null;
    const lastActivity = node ? sessionLatestActivity(node) : program.updatedAt ?? program.createdAt;
    coordinator.threads.push({
      id: formatOverviewThreadId({ kind: "program", programId: program.id }),
      ref: { kind: "program", programId: program.id },
      readKey,
      title: program.name,
      indicator: (input.programQuestions[program.id]?.length ?? 0) > 0
        ? "needs-input"
        : node ? threadIndicator(node, new Set(), input.lastSeen[readKey]) : "idle",
      lastActivity,
      costUsd: null,
      pinned: input.pins.has(readKey),
      program,
      live: node ? sessionIsWorking(node) : false,
    });
  }
  sortThreads(coordinator.threads);

  const sections: OverviewSection[] = [coordinator];
  for (const connection of input.connections) {
    for (const workspace of connection.workspaces) {
      const key = wsKey(connection.sid, workspace.id);
      const runs = input.runsByWs[key] ?? [];
      const workflows = input.workflowsByWs[key] ?? [];
      const scopedSeen: Record<string, string> = {};
      const scopedPins = new Set<string>();
      for (const run of runs) {
        const readKey = threadReadKey(run.id, { sid: connection.sid, ws: workspace.id });
        if (input.lastSeen[readKey]) scopedSeen[run.id] = input.lastSeen[readKey]!;
        if (input.pins.has(readKey)) scopedPins.add(run.id);
      }
      const summaries = buildThreadGroups({
        runs,
        attention: input.attentionByWs[key] ?? new Set(),
        lastSeen: scopedSeen,
        pins: scopedPins,
        scope: { sid: connection.sid, ws: workspace.id },
        namingContext: {
          stripPrefixes: [MANAGER_PREAMBLE],
          workflowNameOf: (id) => workflows.find((workflow) => workflow.id === id)?.name,
        },
      }).flatMap((group) => group.threads);
      const workflowManagerIds = new Set(workflows.map((workflow) => workflow.managerRunId).filter(Boolean));
      const threads = summaries
        .filter((summary) => {
          if (input.filter === "all") return true;
          const root = summary.node.turns[0]!;
          return summary.node.turns.some((run) => workflowManagerIds.has(run.id)) ||
            root.role === "manager" ||
            (!root.parentRunId && root.tags?.some((tag) => tag.startsWith("workflow:")));
        })
        .filter((summary) => !needle || summary.title.toLowerCase().includes(needle) || workspace.name.toLowerCase().includes(needle))
        .map((summary): OverviewThread => {
          const ref: OverviewThreadRef = { kind: "workspace", sid: connection.sid, ws: workspace.id, threadId: summary.id };
          const workflow = workflows.find((candidate) =>
            summary.node.turns.some((run) => run.id === candidate.managerRunId || run.tags?.includes(`workflow:${candidate.id}`)),
          ) ?? null;
          return {
            id: formatOverviewThreadId(ref),
            ref,
            readKey: threadReadKey(summary.id, { sid: connection.sid, ws: workspace.id }),
            title: summary.title,
            indicator: summary.indicator,
            lastActivity: summary.lastActivity,
            costUsd: summary.costUsd,
            pinned: summary.pinned,
            summary,
            workflow,
            live: sessionIsWorking(summary.node),
            workspaceName: workspace.name,
            serverLabel: multiServer ? connection.label : null,
          };
        });
      sortThreads(threads);
      if (!needle || threads.length) {
        sections.push({
          kind: "workspace",
          sid: connection.sid,
          ws: workspace.id,
          key,
          name: workspace.name,
          serverLabel: multiServer ? connection.label : null,
          offline: connection.state !== "open",
          threads,
        });
      }
    }
  }
  return needle && coordinator.threads.length === 0
    ? sections.filter((section) => section.kind !== "coordinator")
    : sections;
}

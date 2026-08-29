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
  filter?: "managers" | "all";
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
    const readKey = threadReadKey(
      formatOverviewThreadId({ kind: "program", programId: program.id }),
      { sid: input.hubSid, ws: "hub" },
    );
    const node = chain.length ? groupRunsByManager(chain)[0] ?? null : null;
    const lastActivity = node ? sessionLatestActivity(node) : null;
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
      const workflowByManagerId = new Map(
        workflows.flatMap((workflow) => workflow.managerRunId
          ? [[workflow.managerRunId, workflow] as const]
          : []),
      );
      const workflowById = new Map(workflows.map((workflow) => [workflow.id, workflow]));
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
          workflowNameOf: (id) => workflowById.get(id)?.name,
        },
      }).flatMap((group) => group.threads);
      const managerOwnedWorkflowIds = new Set(
        summaries.flatMap((summary) => summary.node.turns.flatMap((run) => {
          const workflow = workflowByManagerId.get(run.id);
          return workflow ? [workflow.id] : [];
        })),
      );
      const threads = summaries
        .map((summary): OverviewThread => {
          const ref: OverviewThreadRef = { kind: "workspace", sid: connection.sid, ws: workspace.id, threadId: summary.id };
          const root = summary.node.turns[0]!;
          const workflow = summary.node.turns
            .map((run) => workflowByManagerId.get(run.id))
            .find(Boolean) ?? (!root.parentRunId
              ? root.tags
                ?.map((tag) => tag.startsWith("workflow:") ? workflowById.get(tag.slice(9)) : undefined)
                .find((candidate) => candidate != null && !managerOwnedWorkflowIds.has(candidate.id))
              : undefined) ?? null;
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
  return sections;
}

/** Apply rail-only manager and text filters to an already-built fleet model. */
export function filterOverviewSections(
  sections: readonly OverviewSection[],
  options: { filter: "managers" | "all"; find?: string | null },
): OverviewSection[] {
  const needle = options.find?.trim().toLowerCase();
  const filtered = sections.flatMap((section): OverviewSection[] => {
    const threads = section.threads.filter((thread) => {
      if (thread.ref.kind === "workspace" && options.filter === "managers") {
        const root = thread.summary!.node.turns[0]!;
        if (!thread.workflow && root.role !== "manager" &&
          (root.parentRunId || !root.tags?.some((tag) => tag.startsWith("workflow:")))) return false;
      }
      return !needle || thread.title.toLowerCase().includes(needle) ||
        (section.kind === "workspace" && section.name.toLowerCase().includes(needle));
    });
    return threads.length || !needle ? [{ ...section, threads } as OverviewSection] : [];
  });
  return needle
    ? filtered.filter((section) => section.kind !== "coordinator" || section.threads.length > 0)
    : filtered;
}

/** Resolve canonical program ids and any run id within a workspace thread subtree. */
export function resolveOverviewThread(
  sections: readonly OverviewSection[],
  id: string | null | undefined,
): OverviewThread | null {
  if (!id) return null;
  const ref = parseOverviewThreadId(id);
  if (!ref) return null;
  for (const section of sections) {
    for (const thread of section.threads) {
      if (ref.kind === "program") {
        if (thread.ref.kind === "program" && thread.ref.programId === ref.programId) return thread;
        continue;
      }
      if (thread.ref.kind !== "workspace" || thread.ref.sid !== ref.sid || thread.ref.ws !== ref.ws) {
        continue;
      }
      const contains = (node: ThreadSummary["node"]): boolean =>
        node.turns.some((turn) => turn.id === ref.threadId) || node.workers.some(contains);
      if (contains(thread.summary!.node)) return thread;
    }
  }
  return null;
}

/** Hub questions outside the hub bridge's open fleet are not already in fleet attention. */
export function countExternalProgramQuestions(
  questions: Readonly<Record<string, readonly HubQuestion[]>>,
  connections: OverviewModelInput["connections"],
  hubSid: string,
): number {
  const openWorkspaceIds = new Set(
    connections.find((connection) => connection.sid === hubSid)?.workspaces.map((ws) => ws.id) ?? [],
  );
  return Object.values(questions).reduce(
    (count, rows) => count + rows.filter((question) => !openWorkspaceIds.has(question.ws)).length,
    0,
  );
}

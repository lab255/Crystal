import { z } from "zod";
import { nowIso, uid } from "./ids.js";
import { usageTotalTokens, type AgentRun } from "./agent.js";
import { rosterText, type AgentProfile } from "./agent-profile.js";
import { runCostUsd } from "./orchestration.js";

/**
 * Programs — the coordination layer *above* per-project workflows.
 *
 * A workflow (see `workflow.ts`) drives one goal inside one repo. A
 * **program** is the cross-project unit: one high-level epic, split into
 * **deliveries** — one per project — each of which is handed to that project's
 * own orchestrator as a workflow. The project keeps its full development flow
 * (refine → plan/design → develop/review tracks → merge → release); the
 * program only decides *what* each project is asked for, in *what order*, and
 * against what budget.
 *
 *   program "SSO everywhere"
 *     ├── delivery → workspace `auth-service`   → workflow → manager → workers
 *     └── delivery → workspace `web-console`    → workflow → manager → workers
 *          (dependsOn the auth-service delivery)
 *
 * The pure rules live here (the delivery graph, readiness, spend rollups, the
 * program manager's standing prompt, the agent-facing rendering); enforcement
 * — opening workspaces, starting workflows, wake-ups — lives in the server's
 * HubEngine. Nothing in this file touches a filesystem or a workspace, so the
 * whole graph is unit-testable and shared with the client.
 */

/* ------------------------------------------------------------------ */
/* Projects the hub addresses                                          */
/* ------------------------------------------------------------------ */

/** An open project the hub can dispatch a delivery to. */
export interface HubProject {
  /** Workspace id on the server. */
  ws: string;
  /** Canonical absolute root. */
  root: string;
  name: string;
}

/** A project the hub knows of but which is not open right now. */
export interface HubRecentProject {
  root: string;
  name: string;
  lastOpenedAt: string;
  /** The directory no longer exists on the host. */
  missing?: boolean;
}

/** Outcome of one dispatch wave: what started, and what did not (with why). */
export interface HubDispatchReport {
  dispatched: {
    deliveryId: string;
    projectName: string;
    ws: string;
    workflowId: string;
    /**
     * Tools the project's pre-flight could not resolve (from the workflow's
     * env report) — the dispatch went ahead, but the program manager learns
     * about the broken sandbox here, not from a burned worker run.
     */
    envGaps?: string[];
    /**
     * Brief `assert:` claims the project's premise check found to be FALSE
     * (verbatim claim + why). Same economics as envGaps: the dispatch went
     * ahead, but the program manager learns the brief lied *now* — while
     * rewriting it is still cheaper than the work built on it.
     */
    premiseGaps?: string[];
  }[];
  skipped: { deliveryId: string; projectName: string; reason: string }[];
}

/** Subviews of the Hub mode (deep-link segment after `#/hub`). */
export type HubViewId = "programs" | "projects" | "questions";

/**
 * A question a project's orchestrator (or one of its workers) raised and is
 * waiting on a human for — surfaced up to the program that dispatched the
 * work. This is the one thing that genuinely blocks a program: a delivery
 * that has stopped to ask about a shared contract cannot be unblocked by any
 * other project. Derived from the project's board, never stored here.
 */
export interface HubQuestion {
  deliveryId: string;
  projectName: string;
  /** Workspace the asking project is open as (for the jump to its board). */
  ws: string;
  /** Board task the question hangs off — answering happens there. */
  taskId: string;
  taskTitle: string;
  questionId: string;
  text: string;
  createdAt: string;
}

/* ------------------------------------------------------------------ */
/* Deliveries                                                          */
/* ------------------------------------------------------------------ */

/**
 * Stored delivery states. `blocked` is deliberately *not* one of them: being
 * blocked is a function of the dependency graph, so it is derived
 * ({@link deliveryBlockers}) rather than stored and kept in sync — the same
 * convention as READY on the task board.
 */
export const DELIVERY_STATUSES = [
  "pending",
  "running",
  "paused",
  "completed",
  "failed",
  "cancelled",
] as const;
export const DeliveryStatusSchema = z.enum(DELIVERY_STATUSES);
export type DeliveryStatus = z.infer<typeof DeliveryStatusSchema>;

/** Delivery states that no longer change on their own. */
export function isDeliveryTerminal(status: DeliveryStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

/** Program states that no longer change on their own. */
export function isProgramTerminal(status: ProgramStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

/** A program still in flight — running, or paused and resumable. */
export function isProgramLive(status: ProgramStatus): boolean {
  return status === "running" || status === "paused";
}

/** One project's share of a program: a brief handed to that project's orchestrator. */
export const ProgramDeliverySchema = z.object({
  id: z.string(),
  /** Absolute project root on the host — the addressing key across restarts. */
  projectRoot: z.string(),
  /** Display name (workspace manifest name, or the directory name). */
  projectName: z.string(),
  /**
   * Workspace id the project resolved to, recorded at dispatch. Null until
   * then: a program may be planned against projects this server has never
   * opened, and ids are only meaningful once a workspace is open.
   */
  ws: z.string().nullish(),
  /** What this project is being asked to deliver (the workflow's goal). */
  brief: z.string(),
  /** Workflow template the project runs (null = the project's default). */
  templateId: z.string().nullish(),
  /** Spend ceiling for this delivery's workflow, in USD. */
  budgetUsd: z.number().nullish(),
  /**
   * Per-run spend ceiling handed to the delivery's workflow (its manager
   * turns and workers alike) — the lever against one runaway resume, where
   * `budgetUsd` only catches the accumulated total.
   */
  runCapUsd: z.number().nullish(),
  /**
   * Delivery ids that must complete before this one may be dispatched.
   * De-duplicated on read: a repeated id would make `cyclicDeliveries` count
   * the same edge twice and report the graph as cyclic forever.
   */
  dependsOn: z
    .array(z.string())
    .default([])
    .transform((ids) => [...new Set(ids)]),
  /** The project workflow carrying this delivery, once dispatched. */
  workflowId: z.string().nullish(),
  /**
   * Workflows this delivery ran before — one per retry, oldest first. A retry
   * clears `workflowId`, and spend is attributed by workflow: without this the
   * failed attempt's cost would vanish from the program, and each retry would
   * hand the delivery a fresh budget ceiling it had already spent.
   */
  priorWorkflowIds: z.array(z.string()).default([]),
  status: DeliveryStatusSchema.default("pending"),
  /** Why the delivery is in its current state (dispatch failure, pause reason…). */
  note: z.string().nullish(),
  /** The project manager's closing summary, copied over on completion. */
  summary: z.string().nullish(),
  createdAt: z.string(),
  dispatchedAt: z.string().nullish(),
  endedAt: z.string().nullish(),
});
export type ProgramDelivery = z.infer<typeof ProgramDeliverySchema>;

/* ------------------------------------------------------------------ */
/* Programs                                                            */
/* ------------------------------------------------------------------ */

export const PROGRAM_STATUSES = [
  "running",
  "paused",
  "completed",
  "failed",
  "cancelled",
] as const;
export const ProgramStatusSchema = z.enum(PROGRAM_STATUSES);
export type ProgramStatus = z.infer<typeof ProgramStatusSchema>;

export const ProgramSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** The high-level epic, in the owner's words. */
  goal: z.string(),
  status: ProgramStatusSchema.default("running"),
  /**
   * What paused the program — structured so budget pauses are
   * distinguishable from a deliberate user hold (raising the budget
   * auto-resumes only budget pauses), exactly as workflows do it.
   */
  pausedBy: z.enum(["user", "budget"]).nullish(),
  pausedReason: z.string().nullish(),
  /** Ceiling across every delivery's workflow, in USD. */
  budgetUsd: z.number().nullish(),
  /**
   * Root run of the program manager's resume chain, when one is driving this
   * program. Null for programs steered directly over MCP by an external agent.
   */
  managerRunId: z.string().nullish(),
  deliveries: z.array(ProgramDeliverySchema).default([]),
  /** The program manager's closing summary (set via complete_program). */
  summary: z.string().nullish(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Program = z.infer<typeof ProgramSchema>;

export function createProgram(init: {
  name: string;
  goal: string;
  budgetUsd?: number | null;
}): Program {
  const ts = nowIso();
  return ProgramSchema.parse({
    id: uid("prog"),
    name: init.name,
    goal: init.goal,
    budgetUsd: init.budgetUsd ?? null,
    deliveries: [],
    createdAt: ts,
    updatedAt: ts,
  });
}

export interface DeliveryInit {
  projectRoot: string;
  projectName?: string | null;
  brief: string;
  templateId?: string | null;
  budgetUsd?: number | null;
  runCapUsd?: number | null;
  dependsOn?: string[];
}

/**
 * Add a delivery. Dependencies must reference existing deliveries and must not
 * close a cycle — {@link readyDeliveries} walks the graph as a DAG, and a
 * cycle would silently deadlock the program instead of erroring.
 */
export function addDelivery(
  program: Program,
  init: DeliveryInit,
  at = nowIso(),
): { program: Program; delivery: ProgramDelivery } {
  const dependsOn = [...new Set(init.dependsOn ?? [])];
  for (const dep of dependsOn) {
    if (!program.deliveries.some((d) => d.id === dep)) {
      throw new Error(`Unknown delivery dependency: ${dep}`);
    }
  }
  const delivery = ProgramDeliverySchema.parse({
    id: uid("dlv"),
    projectRoot: init.projectRoot,
    projectName: init.projectName?.trim() || basenameOf(init.projectRoot),
    brief: init.brief,
    templateId: init.templateId ?? null,
    budgetUsd: init.budgetUsd ?? null,
    runCapUsd: init.runCapUsd ?? null,
    dependsOn,
    createdAt: at,
  });
  // Dependencies can only point at deliveries that already exist, so a cycle
  // is structurally impossible here — assert it anyway; the check is cheap and
  // a future edit path (re-pointing dependsOn) would need it.
  const next: Program = {
    ...program,
    deliveries: [...program.deliveries, delivery],
    updatedAt: at,
  };
  const cyclic = cyclicDeliveries(next);
  if (cyclic.length) {
    throw new Error(`Delivery dependency cycle through: ${cyclic.join(", ")}`);
  }
  return { program: next, delivery };
}

/** Delivery ids sitting on a dependency cycle (empty for a valid DAG). */
export function cyclicDeliveries(program: Program): string[] {
  const ids = new Set(program.deliveries.map((d) => d.id));
  const indegree = new Map(program.deliveries.map((d) => [d.id, 0]));
  for (const d of program.deliveries) {
    for (const dep of d.dependsOn) {
      if (dep !== d.id && ids.has(dep)) indegree.set(d.id, (indegree.get(d.id) ?? 0) + 1);
    }
  }
  const queue = program.deliveries.filter((d) => (indegree.get(d.id) ?? 0) === 0).map((d) => d.id);
  const seen = new Set<string>();
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const d of program.deliveries) {
      if (!d.dependsOn.includes(id) || seen.has(d.id)) continue;
      const left = (indegree.get(d.id) ?? 0) - 1;
      indegree.set(d.id, left);
      if (left <= 0) queue.push(d.id);
    }
  }
  return program.deliveries.filter((d) => !seen.has(d.id)).map((d) => d.id);
}

export function deliveryById(program: Program, deliveryId: string): ProgramDelivery | null {
  return program.deliveries.find((d) => d.id === deliveryId) ?? null;
}

/**
 * Apply a patch to one delivery. Returns a new program; never mutates.
 * `endedAt` is stamped when the delivery reaches a terminal state and cleared
 * if it somehow leaves one (a re-dispatch after a failure).
 */
export function patchDelivery(
  program: Program,
  deliveryId: string,
  patch: Partial<Omit<ProgramDelivery, "id" | "createdAt">>,
  at = nowIso(),
): Program {
  if (!program.deliveries.some((d) => d.id === deliveryId)) {
    throw new Error(`Unknown delivery: ${deliveryId}`);
  }
  return {
    ...program,
    deliveries: program.deliveries.map((d) => {
      if (d.id !== deliveryId) return d;
      const next = { ...d, ...patch };
      const status = patch.status ?? d.status;
      if (isDeliveryTerminal(status)) next.endedAt = patch.endedAt ?? d.endedAt ?? at;
      else next.endedAt = null;
      if (status === "running" && !next.dispatchedAt) next.dispatchedAt = at;
      return next;
    }),
    updatedAt: at,
  };
}

/* ------------------------------------------------------------------ */
/* Readiness                                                           */
/* ------------------------------------------------------------------ */

/**
 * Unmet dependencies of a delivery: dependency ids that have not completed.
 * A cancelled or failed dependency blocks forever — that is the point; the
 * owner (or the program manager) decides whether to drop the dependency, retry
 * the failed delivery, or abandon the program.
 */
export function deliveryBlockers(program: Program, delivery: ProgramDelivery): string[] {
  return delivery.dependsOn.filter(
    (dep) => deliveryById(program, dep)?.status !== "completed",
  );
}

/**
 * A live delivery already occupying this delivery's project — in *any*
 * program. The constraint is a property of the repo, not of one program: two
 * orchestrators in one repo collide on branches, worktrees and the board
 * whether or not the same program sent them.
 */
function projectBusy(
  delivery: ProgramDelivery,
  programs: readonly Program[],
): { program: Program; delivery: ProgramDelivery } | null {
  for (const program of programs) {
    for (const d of program.deliveries) {
      if (d.id === delivery.id || d.projectRoot !== delivery.projectRoot) continue;
      if (d.status === "running" || d.status === "paused") return { program, delivery: d };
    }
  }
  return null;
}

export interface DeliveryReadiness {
  ready: boolean;
  /** Why not, when `ready` is false — surfaced verbatim to the agent. */
  reason?: string;
}

/**
 * Whether a delivery may be dispatched right now. Three gates: the program has
 * to be running, the dependency graph has to be satisfied, and the project
 * must not already be carrying another live delivery of this program — two
 * workflow managers in one repo would collide on branches, worktrees and the
 * task board.
 */
export function deliveryReadiness(
  program: Program,
  delivery: ProgramDelivery,
  /**
   * Every other program in the portfolio, so the one-orchestrator-per-project
   * rule holds across programs and not just within one. Omitting it checks
   * only this program — fine for rendering, never for dispatch.
   */
  others: readonly Program[] = [],
): DeliveryReadiness {
  if (program.status !== "running") {
    return { ready: false, reason: `Program is ${program.status}.` };
  }
  if (delivery.status !== "pending") {
    return { ready: false, reason: `Delivery is ${delivery.status}.` };
  }
  const blockers = deliveryBlockers(program, delivery);
  if (blockers.length) {
    // Name *and* id: an agent addresses the delivery by id, a human reads the
    // project it is waiting on.
    const named = blockers.map((id) => {
      const dep = deliveryById(program, id);
      return dep ? `${dep.projectName} (${id})` : id;
    });
    return { ready: false, reason: `Blocked by ${named.join(", ")}.` };
  }
  const busy = projectBusy(delivery, [program, ...others]);
  if (busy) {
    const where =
      busy.program.id === program.id
        ? `delivery ${busy.delivery.id}`
        : `delivery ${busy.delivery.id} of program "${busy.program.name}"`;
    return {
      ready: false,
      reason: `${delivery.projectName} is already running ${where} — one orchestrator per project at a time.`,
    };
  }
  return { ready: true };
}

/**
 * Every delivery that may be dispatched right now, in creation order. Pass
 * the rest of the portfolio so a project already busy for *another* program is
 * not reported ready.
 */
export function readyDeliveries(
  program: Program,
  others: readonly Program[] = [],
): ProgramDelivery[] {
  const out: ProgramDelivery[] = [];
  // Projects already claimed by this pass: two pending deliveries on the same
  // project must not both be reported ready (one orchestrator per project).
  const taken = new Set<string>();
  for (const delivery of program.deliveries) {
    if (taken.has(delivery.projectRoot)) continue;
    if (!deliveryReadiness(program, delivery, others).ready) continue;
    out.push(delivery);
    taken.add(delivery.projectRoot);
  }
  return out;
}

/**
 * The program's own terminal state, if it has reached one: every delivery is
 * terminal, and at least one exists. A program with any failed or cancelled
 * delivery fails — partial delivery of a cross-project epic is not success,
 * and the owner should see it as such. Null while work remains.
 */
export function programOutcome(program: Program): "completed" | "failed" | null {
  if (!program.deliveries.length) return null;
  if (!program.deliveries.every((d) => isDeliveryTerminal(d.status))) return null;
  return program.deliveries.every((d) => d.status === "completed") ? "completed" : "failed";
}

/* ------------------------------------------------------------------ */
/* Spend                                                               */
/* ------------------------------------------------------------------ */

/** Per-delivery spend, as reported by that delivery's project workflow. */
export interface DeliverySpend {
  costUsd: number;
  totalTokens: number;
  runCount: number;
  liveRunCount: number;
}

export interface ProgramSpend extends DeliverySpend {
  /** Spend keyed by delivery id — the rollup's breakdown. */
  byDelivery: Record<string, DeliverySpend>;
  /** The program manager session's own spend (coordination overhead). */
  manager: DeliverySpend;
  /**
   * True when a live delivery's cost could not be read — its project is
   * closed, so its workflow is unreachable. The total is then a *lower bound*,
   * and treating it as the truth would silently disable budget enforcement
   * while the work keeps spending.
   */
  stale: boolean;
}

export function emptyDeliverySpend(): DeliverySpend {
  return { costUsd: 0, totalTokens: 0, runCount: 0, liveRunCount: 0 };
}

/**
 * Fold one delivery's workflows into a single figure — a retried delivery has
 * more than one, and every attempt was paid for. Null parts (unreadable, or
 * never dispatched) contribute nothing; all-null means "no spend to report",
 * which is not the same as zero and so comes back null.
 */
export function sumDeliverySpend(
  parts: readonly (DeliverySpend | null)[],
): DeliverySpend | null {
  const known = parts.filter((p): p is DeliverySpend => !!p);
  if (!known.length) return null;
  return known.reduce(
    (acc, p) => ({
      costUsd: acc.costUsd + p.costUsd,
      totalTokens: acc.totalTokens + p.totalTokens,
      runCount: acc.runCount + p.runCount,
      liveRunCount: acc.liveRunCount + p.liveRunCount,
    }),
    emptyDeliverySpend(),
  );
}

/**
 * Sum per-delivery spend, plus the program manager's own coordination cost,
 * into the program total. Deliveries that have not been dispatched contribute
 * nothing; the manager term is what makes a program's spend add up to more
 * than the sum of its workflows.
 */
export function programSpend(
  byDelivery: Record<string, DeliverySpend>,
  manager: DeliverySpend = emptyDeliverySpend(),
  /** Set when a live delivery's cost could not be read (see {@link ProgramSpend.stale}). */
  stale = false,
): ProgramSpend {
  const total = emptyDeliverySpend();
  for (const spend of [...Object.values(byDelivery), manager]) {
    total.costUsd += spend.costUsd;
    total.totalTokens += spend.totalTokens;
    total.runCount += spend.runCount;
    total.liveRunCount += spend.liveRunCount;
  }
  return { ...total, byDelivery, manager, stale };
}

const PROGRAM_TAG_PREFIX = "program:";

/** Dimensional tag carried by every run belonging to a program (its manager chain). */
export function programTag(programId: string): string {
  return `${PROGRAM_TAG_PREFIX}${programId}`;
}

/** True for tags minted by {@link programTag} — the single prefix check. */
export function isProgramTag(tag: string): boolean {
  return tag.startsWith(PROGRAM_TAG_PREFIX);
}

/** The program id a run belongs to (from its tags), or null. */
export function programIdOfRun(run: Pick<AgentRun, "tags">): string | null {
  // Records predating the tags field must read as "no program", not crash.
  for (const tag of run.tags ?? []) {
    if (isProgramTag(tag)) return tag.slice(PROGRAM_TAG_PREFIX.length) || null;
  }
  return null;
}

/** Spend across the program manager's runs (the `program:<id>`-tagged chain). */
export function managerSpend(programId: string, runs: readonly AgentRun[]): DeliverySpend {
  const tag = programTag(programId);
  const spend = emptyDeliverySpend();
  for (const run of runs) {
    if (!(run.tags ?? []).includes(tag)) continue;
    spend.totalTokens += usageTotalTokens(run.usage);
    spend.costUsd += runCostUsd(run);
    spend.runCount += 1;
    if (run.status === "running" || run.status === "queued") spend.liveRunCount += 1;
  }
  return spend;
}

export interface ProgramBudgetState {
  budgetUsd: number | null;
  spentUsd: number;
  /** Null when no budget is set (unlimited). */
  remainingUsd: number | null;
  exhausted: boolean;
  /** The spend behind this is a lower bound (see {@link ProgramSpend.stale}). */
  stale: boolean;
}

export function programBudgetState(program: Program, spend: ProgramSpend): ProgramBudgetState {
  const budget = program.budgetUsd ?? null;
  const remaining = budget != null ? budget - spend.costUsd : null;
  return {
    budgetUsd: budget,
    spentUsd: spend.costUsd,
    remainingUsd: remaining,
    // Only claim exhaustion from a total we actually know: a closed project
    // hides its delivery's cost, and pausing (or not) on that would be a
    // decision made on a number we cannot stand behind.
    exhausted: !spend.stale && remaining != null && remaining <= 0,
    stale: spend.stale,
  };
}

/* ------------------------------------------------------------------ */
/* Agent-facing rendering                                              */
/* ------------------------------------------------------------------ */

/**
 * The goal text handed to a project's workflow when its delivery is
 * dispatched. The project orchestrator refines and plans against this, so it
 * carries the program's intent, this project's brief, and the cross-project
 * context it must not re-litigate: which sibling projects are involved, and
 * what already shipped upstream that this delivery builds on.
 */
export function deliveryGoalText(program: Program, delivery: ProgramDelivery): string {
  const lines = [
    `Program: ${program.name}`,
    "",
    `Program goal (the cross-project epic this belongs to):`,
    program.goal.trim(),
    "",
    `Your project's delivery (${delivery.projectName}):`,
    delivery.brief.trim(),
  ];
  const siblings = program.deliveries.filter((d) => d.id !== delivery.id);
  if (siblings.length) {
    lines.push(
      "",
      "Sibling deliveries in this program (other teams' orchestrators own these — do NOT implement them here):",
      ...siblings.map((d) => `- ${d.projectName} [${d.status}]: ${headline(d.brief)}`),
    );
  }
  const upstream = delivery.dependsOn
    .map((dep) => deliveryById(program, dep))
    .filter((d): d is ProgramDelivery => !!d);
  if (upstream.length) {
    lines.push(
      "",
      "This delivery was unblocked by upstream work that is already done — build on it rather than redoing it:",
      ...upstream.map(
        (d) => `- ${d.projectName}: ${d.summary?.trim() || headline(d.brief)}`,
      ),
    );
  }
  lines.push(
    "",
    "Scope: everything above is context; you own only your project's delivery. Escalate " +
      "cross-project decisions (shared contracts, API shapes, rollout order) with ask_question " +
      "instead of assuming — the program owner routes them to the other projects.",
  );
  return lines.join("\n");
}

/** One delivery's line in a status rendering. */
function deliveryLine(
  program: Program,
  delivery: ProgramDelivery,
  others: readonly Program[] = [],
): string {
  const blockers = deliveryBlockers(program, delivery);
  const crossProgramLock = projectBusy(delivery, others);
  const bits = [
    `- ${delivery.id} ${delivery.projectName} [${delivery.status}]`,
    delivery.status === "pending" && blockers.length ? `blocked by ${blockers.join(", ")}` : null,
    delivery.status === "pending" && crossProgramLock
      ? `LOCKED by program "${crossProgramLock.program.name}" delivery ${crossProgramLock.delivery.id}`
      : null,
    delivery.workflowId ? `workflow ${delivery.workflowId}` : null,
    delivery.budgetUsd != null ? `budget $${delivery.budgetUsd.toFixed(2)}` : null,
    delivery.runCapUsd != null ? `run cap $${delivery.runCapUsd.toFixed(2)}` : null,
  ].filter(Boolean);
  const detail = [
    `    ${headline(delivery.brief)}`,
    delivery.summary ? `    summary: ${headline(delivery.summary)}` : null,
    delivery.note ? `    note: ${delivery.note}` : null,
  ].filter(Boolean);
  return [bits.join(" · "), ...detail].join("\n");
}

/** The `program_status` tool text: deliveries, dependency state, spend vs budget. */
export function programStatusText(
  program: Program,
  spend: ProgramSpend,
  /** Open questions from the projects, if any — the only true blockers. */
  questions: readonly HubQuestion[] = [],
  /**
   * The rest of the portfolio. Without it the "ready to dispatch" line lists
   * deliveries that `dispatch` will refuse, because their project is busy for
   * another program — telling the manager the opposite of the truth.
   */
  others: readonly Program[] = [],
): string {
  const lines = [
    `Program ${program.id}: ${program.name} [${program.status}]` +
      (program.pausedReason ? ` — ${program.pausedReason}` : ""),
    `Goal: ${program.goal}`,
  ];
  if (program.summary) lines.push(`Summary: ${program.summary}`);
  lines.push("", "Deliveries:");
  if (!program.deliveries.length) {
    lines.push("- (none yet — add_delivery to split the goal across projects)");
  }
  for (const delivery of program.deliveries) {
    lines.push(deliveryLine(program, delivery, others));
    const own = spend.byDelivery[delivery.id];
    if (own?.runCount) {
      lines.push(
        `    spend: $${own.costUsd.toFixed(2)} across ${own.runCount} runs (${own.liveRunCount} live)`,
      );
    }
  }
  if (questions.length) {
    lines.push(
      "",
      "NEEDS AN ANSWER (a project stopped to ask — nothing else unblocks it):",
      ...questions.map(
        (q) =>
          `- ${q.projectName} (${q.deliveryId}) on task ${q.taskId} "${q.taskTitle}":\n    ${q.text}`,
      ),
      "Answer with answer_question — that records it on the project's board and hands it back to " +
        "the run that stopped, which then carries on. message_delivery only steers; it leaves the " +
        "question open.",
    );
  }
  const ready = readyDeliveries(program, others);
  lines.push(
    "",
    ready.length
      ? `Ready to dispatch: ${ready.map((d) => `${d.id} (${d.projectName})`).join(", ")}`
      : "Ready to dispatch: none",
  );
  if (spend.manager.runCount) {
    lines.push(
      `Coordination (this session): $${spend.manager.costUsd.toFixed(2)} across ${spend.manager.runCount} turns`,
    );
  }
  const budget = programBudgetState(program, spend);
  lines.push(
    `Spend: $${spend.costUsd.toFixed(2)} across ${spend.runCount} runs (${Math.round(spend.totalTokens / 1000)}k tok, ${spend.liveRunCount} live)` +
      (budget.budgetUsd != null
        ? ` — budget $${budget.budgetUsd.toFixed(2)}, remaining $${Math.max(0, budget.remainingUsd ?? 0).toFixed(2)}${budget.exhausted ? " (EXHAUSTED)" : ""}`
        : " — no program budget set") +
      (spend.stale
        ? " — INCOMPLETE: a project is closed, so its delivery's cost is not counted"
        : ""),
  );
  return lines.join("\n");
}

/** The portfolio view: every program, one block each, newest first. */
export function portfolioStatusText(
  entries: readonly { program: Program; spend: ProgramSpend; questions?: readonly HubQuestion[] }[],
): string {
  if (!entries.length) {
    return "No programs yet. Use create_program (then add_delivery + dispatch_program), or dispatch_epic for a single-project epic.";
  }
  const live = entries.filter((e) => e.program.status === "running" || e.program.status === "paused");
  const total = entries.reduce((sum, e) => sum + e.spend.costUsd, 0);
  // Every element is joined by the separator, so the header is one entry —
  // slipping a blank line in here would render as an empty program block.
  return [
    `${entries.length} program(s), ${live.length} live — total spend $${total.toFixed(2)}`,
    ...entries.map((entry) =>
      programStatusText(
        entry.program,
        entry.spend,
        entry.questions ?? [],
        entries
          .filter((other) => other.program.id !== entry.program.id)
          .map((other) => other.program),
      ),
    ),
  ].join("\n\n---\n\n");
}

/**
 * The wake-up text delivered to a program manager when one of its deliveries
 * settles. Mirrors the worker-settlement notice a project manager gets — the
 * program manager is woken with results instead of polling program_status.
 */
export function deliverySettledNotice(
  program: Program,
  delivery: ProgramDelivery,
): string {
  const head =
    `Delivery ${delivery.id} (${delivery.projectName}) settled: ${delivery.status}` +
    (delivery.workflowId ? ` · workflow ${delivery.workflowId}` : "");
  const body = (delivery.summary ?? delivery.note ?? "(no summary reported)").trim();
  const unblocked = program.deliveries.filter(
    (d) => d.status === "pending" && d.dependsOn.includes(delivery.id),
  );
  const tail = unblocked.length
    ? `\n\nThis may have unblocked: ${unblocked.map((d) => `${d.id} (${d.projectName})`).join(", ")}.`
    : "";
  return `${head}\n${body}${tail}`;
}

/**
 * The wake-up text for questions a program's projects just raised. A question
 * is the one thing that stalls a delivery with no way for the hub to route
 * around it, so the manager is woken for it the same way it is woken for a
 * settled delivery.
 */
export function questionsNotice(questions: readonly HubQuestion[]): string {
  const head =
    questions.length === 1
      ? "A project is waiting on an answer:"
      : `${questions.length} projects are waiting on answers:`;
  return [
    head,
    ...questions.map(
      (q) => `- ${q.projectName} (delivery ${q.deliveryId}, task ${q.taskId}): ${q.text}`,
    ),
    "",
    "Answer what you can decide yourself with answer_question — that records it on the project's " +
      "board and hands it back to the run that stopped, which then carries on. A cross-project " +
      "contract is yours to settle, and settling it in one project means writing the same " +
      "decision into the others (message_delivery for those — it steers, but it does not clear " +
      "a question). Escalate to the owner only what genuinely needs them.",
  ].join("\n");
}

/** The `list_projects` tool text: what a dispatch can address, and how to name it. */
export function projectListText(
  open: readonly HubProject[],
  recent: readonly HubRecentProject[],
): string {
  const lines: string[] = [];
  lines.push(open.length ? "Open projects:" : "No projects are open.");
  for (const p of open) lines.push(`- ${p.name} · ws ${p.ws} · ${p.root}`);
  if (recent.length) {
    lines.push("", "Recently opened (dispatching to one of these reopens it):");
    for (const r of recent) {
      lines.push(`- ${r.name} · ${r.root}${r.missing ? " (directory is gone)" : ""}`);
    }
  }
  return lines.join("\n");
}

/** What one dispatch wave started, and what it did not — with the reason. */
export function dispatchReportText(report: HubDispatchReport): string {
  const lines: string[] = [];
  if (report.dispatched.length) {
    lines.push("Dispatched:");
    for (const d of report.dispatched) {
      lines.push(
        `- ${d.deliveryId} → ${d.projectName} (workflow ${d.workflowId})` +
          (d.envGaps?.length
            ? ` — ENVIRONMENT GAPS: ${d.envGaps.join(", ")} missing in that workspace; expect its orchestrator to raise a question rather than build`
            : ""),
      );
      if (d.premiseGaps?.length) {
        lines.push(
          `    FAILED PREMISES — the brief asserts things that project says are false:`,
          ...d.premiseGaps.map((g) => `    · ${g}`),
          `    Rewrite the brief (or fix the repo) and steer that orchestrator now — it was told to stop and ask rather than build on these.`,
        );
      }
    }
  }
  if (report.skipped.length) {
    if (lines.length) lines.push("");
    lines.push("Not dispatched:");
    for (const s of report.skipped) lines.push(`- ${s.deliveryId} (${s.projectName}): ${s.reason}`);
  }
  return lines.length ? lines.join("\n") : "Nothing to dispatch.";
}

/** Frame an owner's interactive message for delivery into the program manager session. */
export function formatProgramMessage(text: string): string {
  return `OWNER MESSAGE:\n${text.trim()}\n\nThis is steering from the program's owner. Acknowledge it, adjust the deliveries/dispatches accordingly, and keep driving the program.`;
}

/**
 * The program manager's kickoff prompt: the standing directive that makes one
 * interactive Claude session own a cross-project epic — splitting it into
 * per-project deliveries, handing each to that project's own orchestrator, and
 * sequencing them — without ever writing code itself.
 */
export function buildProgramManagerPrompt(
  program: Program,
  /** Shared agent library (hub scope — project rosters don't apply here). */
  roster: readonly AgentProfile[] = [],
): string {
  const budget =
    program.budgetUsd != null
      ? `The program budget is $${program.budgetUsd.toFixed(2)} across every project. Give each delivery its own budget so no single project can drain the program, and check program_status between waves.`
      : "No program budget is set, but you still account for cost: give each delivery a budget, and check program_status between waves.";
  const deliveries = program.deliveries.length
    ? program.deliveries.map((d) => `- ${d.id} ${d.projectName}: ${headline(d.brief)}`).join("\n")
    : "(none yet — you plan them)";
  const agents = rosterText(roster);
  return [
    `You are the PROGRAM MANAGER of "${program.name}" (${program.id}) — a long-lived, interactive session owning one epic that spans several projects. You coordinate project orchestrators; you never write code and never edit files yourself.`,
    "",
    `Program goal:\n${program.goal.trim()}`,
    "",
    `Deliveries so far:\n${deliveries}`,
    ...(agents
      ? [
          "",
          "Shared agent library (each project's orchestrator dispatches these by agentId — name one in a brief when a delivery should run as a specific agent):",
          agents,
        ]
      : []),
    "",
    "Operating protocol:",
    "- SURVEY first: list_projects shows every project this Crystal server knows (open and recently opened). open_project brings one under management. project_board reads a project's board when you need to know what is already planned there.",
    "- SPLIT the goal into one delivery per project with add_delivery. A delivery's brief is what THAT project is asked to deliver, written so its own orchestrator can refine and plan against it — outcomes and contracts, not implementation steps. Use dependsOn when one project must land before another can start (shared API first, consumers after).",
    "- ASSERT the brief's checkable claims. Any factual premise a brief relies on (a branch that should exist, a file, a tool, a command that must pass) goes in as its own `assert:` line — `assert: branch release/2.3`, `assert: file api/openapi.yaml`, `assert: tool gh`, `assert: cmd gh pr view 204 --json state`. They are verified against the real repo at dispatch and failures come back on the dispatch report — a false premise caught there costs nothing; discovered by the orchestrator it costs runs.",
    "- DISPATCH with dispatch_program: every unblocked delivery starts as a workflow inside its own project, driven by that project's orchestrator through its full development flow (refine → plan/design → develop/review tracks → merge → release). You do not manage that flow; the project manager does.",
    "- WAIT. You are resumed automatically whenever a delivery settles, and dependent deliveries are dispatched for you as their dependencies complete. End your turn after dispatching instead of polling program_status in a loop.",
    "- STEER: message_delivery sends a note into a running project orchestrator's session (a changed contract, a decision from another project, a correction). Use it rather than starting a second delivery in the same project — one orchestrator per project at a time, across the whole portfolio. Steers QUEUE for the next natural wake by default (free); wake: true forces a paid resume — spend it only when the note must beat the next settlement. Read the receipt: it tells you whether the note landed, is queued, or would wait forever.",
    "- ANSWER: when a project stops to ask something, program_status lists it under NEEDS AN ANSWER. answer_question is what clears it and restarts the run that stopped; message_delivery does not.",
    "- CLOSE: when a delivery's work was settled outside its workflow (done by hand, absorbed elsewhere, moot), close_delivery records the outcome + note and unblocks its dependents — do not leave it running to \"finish\" work that no longer exists, and do not complete the whole program around it.",
    "- COMPACT: a long-lived orchestrator re-ingests its whole transcript on every wake. If a delivery's spend is climbing while its board barely moves, compact_delivery (between waves) reseeds it from durable state and cuts the per-wake cost.",
    "",
    "Rules:",
    `- Cost is yours to control. ${budget}`,
    "- Keep briefs decoupled: if two projects need to agree on something (an API shape, an event schema, a rollout order), decide it yourself, write it into BOTH briefs, and note it — do not let two orchestrators invent it independently.",
    "- The owner can message you at any time; those turns start with \"OWNER MESSAGE\". Treat them as steering, acknowledge, and adjust.",
    "- When every delivery has landed — or the program is genuinely blocked — call complete_program with a summary of what shipped per project, what it cost, and anything left open.",
  ].join("\n");
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/**
 * First line of a block of text, capped with an ellipsis — the one way this
 * feature turns a goal or a brief into a label, so a program named by
 * `dispatch_epic` and one named in the UI agree.
 */
export function headline(text: string, max = 120): string {
  const first = (text.split("\n").find((l) => l.trim()) ?? "").trim();
  return first.length > max ? `${first.slice(0, max)}…` : first;
}

/** Last path segment of a root, for a default project name (no node:path in core). */
function basenameOf(root: string): string {
  const parts = root.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || root;
}

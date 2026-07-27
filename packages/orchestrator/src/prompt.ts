import { QUESTION_MARKER, type TaskItem, type WorkspaceInfo } from "@crystal/core";

/**
 * Build the agent prompt for a task: the task text (or the prepared dispatch
 * prompt the task was minted with) plus any workspace context Crystal knows
 * about (linked architecture nodes, repos, files), plus the async-question
 * protocol so a blocked agent can hand a decision back to the human owner.
 */
export function buildTaskPrompt(task: TaskItem, info: WorkspaceInfo | null): string {
  const lines: string[] = [];
  if (task.agentPrompt?.trim()) {
    lines.push(task.agentPrompt.trim());
  } else {
    lines.push(task.title.trim());
    if (task.description.trim()) {
      lines.push("", task.description.trim());
    }
  }

  const context: string[] = [];
  if (info) {
    const nodes = info.architectures
      .flatMap((a) => a.graph.nodes)
      .filter((n) => task.links.nodeIds.includes(n.id));
    if (nodes.length) {
      context.push(
        `Architecture components in scope: ${nodes
          .map((n) => `${n.label} (${n.kind}${n.description ? `: ${n.description}` : ""})`)
          .join(", ")}`,
      );
    }
    const repos = info.manifest.repos.filter((r) => task.links.repoIds.includes(r.id));
    if (repos.length) {
      context.push(`Repos in scope: ${repos.map((r) => `${r.name} at ${r.path}`).join(", ")}`);
    }
  }
  if (task.links.files.length) {
    context.push(`Relevant files: ${task.links.files.join(", ")}`);
  }
  if (context.length) {
    lines.push("", "Context from Crystal:", ...context.map((c) => `- ${c}`));
  }
  lines.push(
    "",
    `If you are blocked on a decision only a human can make, print a line starting with "${QUESTION_MARKER} <your question>" and finish your reply — the answer arrives as a follow-up prompt.`,
  );
  return lines.join("\n");
}

/**
 * Manager framing for a board-driving run. Prepended to a goal so the run acts
 * as an orchestrator: it structures the goal on the board (epics + tasks with
 * blockers), respects the lease discipline, and delegates through tracked
 * worker runs. The board tools ride the same in-process MCP endpoint as
 * `dispatch_worker`; the CRYSTAL_DISPATCH marker stays as the no-tools
 * fallback. The loop is event-driven: the server resumes the manager's
 * session when dispatched workers settle, so the preamble teaches
 * dispatch-then-end-turn, not polling. Cost attribution is automatic (runs
 * bill their task; epics roll up), which is why accurate `taskId`s on
 * dispatch matter.
 */
export const MANAGER_PREAMBLE =
  "You are a manager agent: turn the goal below into a well-ordered board and " +
  "drive it to done by delegating. You write structure and coordination, not code.\n\n" +
  "The board is the single source of truth — coordinate through it, never " +
  "through worker memory. Your `mcp__crystal__*` tools:\n" +
  "- board_status — epics + tasks with status, blockers, leases, cost. Read it first.\n" +
  "- get_task — one task in full: acceptance criteria, blockers, questions. Read it " +
  "before dispatching or reviewing that task.\n" +
  "- create_epic / create_task — break the goal into an epic and small, shippable " +
  "tasks with testable acceptance in the description, priorities, and `blockedBy` " +
  "ids for ordering.\n" +
  "- claim_task — take the exclusive write lease BEFORE working or updating a task " +
  "(one writer per task; keep the returned claimId; stale leases from crashed " +
  "agents heal automatically).\n" +
  "- update_task / release_task — move status (backlog → in_progress → review → done) " +
  "and free the lease when you hand off.\n" +
  "- dispatch_worker — delegate implementation to a worker run; pass `taskId` so its " +
  "cost bills the right task and it inherits the task's lease, and `purpose` " +
  "(implement, code-review, fix…). Workers can move their own task and ask the " +
  "human questions; they cannot dispatch.\n" +
  "- worker_status / worker_result — what your workers are doing, and a settled " +
  "worker's full output (final message, files touched, diffstat) for review.\n" +
  "- ask_question — file a decision for the human owner on a task, with your " +
  "recommended default. Never block on it; keep driving unblocked work.\n\n" +
  "THE LOOP: read the board → structure it → claim + dispatch every unblocked task " +
  "(independent tasks in parallel) → END YOUR TURN. You are resumed automatically " +
  "with results when workers settle — never busy-poll worker_status. On each " +
  "wake-up: review with worker_result against the task's acceptance criteria, move " +
  "done+green tasks to review and dispatch a reviewer (purpose \"code-review\"), " +
  "route findings back to the original author, then dispatch the next READY tasks " +
  "and end your turn again. Done only after review.\n\n" +
  "Cost is attributed automatically: every run bills its task and epics roll up, " +
  "so keep taskId accurate on every dispatch. If the tools are unavailable, " +
  'dispatch with a single line: CRYSTAL_DISPATCH: {"prompt": "<worker task>", ' +
  '"taskId": "<id>"} and escalate with a CRYSTAL_QUESTION: line.\n\nGoal:\n';

/**
 * The goal handed to a manager started from the board's "N ready · no active
 * manager" chip: the board is already structured, so the directive is to
 * drive what exists, not to replan it.
 */
export function buildBoardManagerGoal(projectName: string, ready: readonly TaskItem[]): string {
  const shown = ready.slice(0, 12);
  const list = shown.map((t) => `- ${t.title} (${t.id})`).join("\n");
  return (
    `Drive the existing "${projectName}" board to done. The structure is already ` +
    `there — do not rebuild it. Read board_status, then claim and dispatch every ` +
    `READY task, review settled work against its acceptance criteria, and keep ` +
    `going until nothing is READY.\n\nREADY right now:\n${list}` +
    (ready.length > shown.length ? `\n… +${ready.length - shown.length} more` : "")
  );
}

/**
 * Run formatters live in `@crystal/client` beside `RunTranscript`, which
 * renders through them — re-exported here under their historic names so the
 * `<$0.01` threshold and the k/M cut-overs have exactly one definition.
 */
export {
  formatRunCost as formatCost,
  formatRunDuration as formatDuration,
  formatRunTokens as formatTokens,
} from "@crystal/client";

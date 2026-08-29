import {
  formatOverviewThreadId,
  formatWsRef,
  parseOverviewThreadId,
  type AgentRun,
  type DeepLink,
  type HubQuestion,
} from "@crystal/core";
import type { FleetQuestion } from "./fleet-store.js";
import type { NavPatch } from "./nav-store.js";

/**
 * Pure half of the attention notifier: where a notification item lives on
 * screen and where a click on it should land. Kept free of React so the two
 * decisions the notifier makes for every toast — "is this already in front of
 * the user?" and "which link opens it?" — are unit-testable, and so the two
 * surfaces that show threads (the in-project Threads mode and the Overview's
 * cross-project Threads view) can never drift apart in either decision.
 */

/** One notification item, addressed well enough to jump to it from anywhere. */
export type AttentionTarget =
  | { kind: "question"; sid: string; ws: string; question: FleetQuestion }
  | { kind: "failure"; sid: string; ws: string; run: AgentRun }
  | { kind: "run"; sid: string; ws: string; run: AgentRun }
  | { kind: "workflow"; sid: string; ws: string; workflowId: string }
  /** A project's question surfaced through a program — the project itself is
   *  not open in this fleet, so only the coordinator thread can show it. */
  | { kind: "program-question"; sid: string; programId: string; question: HubQuestion }
  /** A settled program-manager turn. */
  | { kind: "program-run"; sid: string; programId: string; run: AgentRun };

export interface OnScreenContext {
  /** `document.hasFocus()` — an unfocused window shows nothing to anyone. */
  focused: boolean;
  activeSid: string;
  activeWs: string | null;
}

/** The run id a workspace-scoped target is displayed under, or null. */
function targetRunId(target: AttentionTarget): string | null {
  switch (target.kind) {
    case "question":
      return target.question.question.runId ?? null;
    case "failure":
    case "run":
      return target.run.id;
    default:
      return null;
  }
}

/**
 * True when the exact item is already in front of the user, so a toast would
 * only echo the UI. Conservative by construction: a thread selection is "any
 * run id in the chain", so only exact-id equality counts — a mismatch may still
 * be on screen (another turn of the same chain), but a false "on screen" would
 * swallow the toast, which is the worse failure. Workflow pauses have no
 * dedicated surface anymore, so they are never suppressed.
 */
export function attentionOnScreen(
  link: DeepLink,
  ctx: OnScreenContext,
  target: AttentionTarget,
): boolean {
  if (!ctx.focused) return false;
  if (target.kind === "workflow") return false;
  if (link.mode === "threads") {
    if (target.kind === "program-question" || target.kind === "program-run") return false;
    if (!ctx.activeWs || target.sid !== ctx.activeSid || target.ws !== ctx.activeWs) return false;
    const runId = targetRunId(target);
    return runId != null && link.threads?.thread === runId;
  }
  if (link.mode === "projects" && (link.projects?.view ?? "dashboard") === "threads") {
    const selected = link.projects?.thread ? parseOverviewThreadId(link.projects.thread) : null;
    if (!selected) return false;
    if (target.kind === "program-question" || target.kind === "program-run") {
      // The hub store is per active server: a program row on screen is the
      // active bridge's program of that id.
      return (
        selected.kind === "program"
        && target.sid === ctx.activeSid
        && selected.programId === target.programId
      );
    }
    if (selected.kind !== "workspace") return false;
    if (selected.sid !== target.sid || selected.ws !== target.ws) return false;
    const runId = targetRunId(target);
    return runId != null && selected.threadId === runId;
  }
  return false;
}

export interface AttentionJump {
  /** Workspace to make active first (null = leave the active workspace alone). */
  select: { sid: string; ws: string } | null;
  patch: NavPatch;
}

/**
 * Where a click on a notification lands. From the Overview the jump stays in
 * mission control — the item opens in the cross-project Threads view rather
 * than yanking the user into one project; from anywhere else a workspace item
 * activates its workspace and opens the in-project thread. Coordinator items
 * only exist in the Overview. `compose: null` everywhere — a jump must land on
 * the target thread (or the rail), never on a stale New-thread composer (nav
 * merge keeps omitted keys).
 */
export function attentionJump(currentMode: DeepLink["mode"], target: AttentionTarget): AttentionJump {
  if (target.kind === "program-question" || target.kind === "program-run") {
    return {
      select: null,
      patch: {
        mode: "projects",
        projects: {
          view: "threads",
          thread: formatOverviewThreadId({ kind: "program", programId: target.programId }),
          program: null,
          compose: null,
        },
      },
    };
  }
  const runId = targetRunId(target);
  if (currentMode === "projects") {
    return {
      select: null,
      patch: {
        mode: "projects",
        projects: {
          view: "threads",
          thread: runId
            ? formatOverviewThreadId({ kind: "workspace", sid: target.sid, ws: target.ws, threadId: runId })
            : null,
          program: null,
          compose: null,
        },
      },
    };
  }
  return {
    select: { sid: target.sid, ws: target.ws },
    patch: {
      ws: formatWsRef(target.sid, target.ws),
      mode: "threads",
      threads: runId ? { thread: runId, compose: null } : { compose: null },
    },
  };
}

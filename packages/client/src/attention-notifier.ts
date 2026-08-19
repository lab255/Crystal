import { useEffect, useRef } from "react";
import {
  ActiveTransitionTracker,
  AttentionTracker,
  automaticWorkflowPauseIds,
  failureAttentionId,
  questionAttentionId,
  runAttentionId,
  settledRunReviews,
  workflowPauseAttentionId,
  type AgentRun,
  type ProjectEntry,
  type Workflow,
} from "@crystal/core";
import { wsKey } from "./fleet-client.js";
import { useCrystal, useFleet, useNav, useWorkflows, useWorkspaces } from "./provider.js";
import { useSettings } from "./settings.js";
import {
  useAttentionJump,
  useFleetNeedsYou,
  type AttentionTarget,
} from "./fleet-needs-you.js";

/**
 * Desktop/browser notifications on transitions that need the operator: new
 * attention items anywhere in the fleet, settled runs ready for review, and
 * budget/stall workflow pauses in the active workspace. Every source seeds
 * silently on its first read, so reloads and workspace opens never announce
 * existing state. Runs are claimed once by id across failure/review categories;
 * workflow pauses re-arm after a resume. The exact item currently on screen is
 * skipped — in a focused window that toast would only echo the UI.
 *
 * Backends: the web Notification API in the browser; in the Tauri webview
 * (which has no web Notification support) the shell's own `notify_attention`
 * command, whose Rust side keeps the toast's activation callback — on click it
 * focuses the window and echoes the target back on the `attention-clicked`
 * event, which the listener below turns into the same `useAttentionJump`
 * navigation the web Notification onclick performs. The Tauri modules load
 * dynamically like the updater so the browser build never fetches them.
 * Permission is a browser concern only, requested lazily on the first
 * announcement, never at startup — desktop toasts need no grant.
 */

/** True only inside the Tauri webview (same probe as desktop-update.ts). */
function inTauriWebview(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as unknown as Record<string, unknown>;
  return "__TAURI_INTERNALS__" in w || "isTauri" in w || "__TAURI__" in w;
}

async function deliver(
  title: string,
  body: string,
  target: AttentionTarget,
  onClick: () => void,
): Promise<void> {
  if (inTauriWebview()) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      // The target rides to Rust untouched and comes back verbatim on the
      // `attention-clicked` event when the toast is activated.
      await invoke("notify_attention", { title, body, target });
    } catch {
      /* older shell without the notifier command — stay silent */
    }
    return;
  }
  if (typeof Notification === "undefined") return;
  let permission = Notification.permission;
  if (permission === "default") {
    try {
      permission = await Notification.requestPermission();
    } catch {
      return;
    }
  }
  if (permission !== "granted") return;
  const toast = new Notification(title, { body });
  toast.onclick = () => {
    window.focus();
    onClick();
    toast.close();
  };
}

type NeedsYouTarget = Extract<AttentionTarget, { kind: "question" | "failure" }>;

function describeAttention(
  target: NeedsYouTarget,
  wsName: string,
): { title: string; body: string } {
  if (target.kind === "question") {
    return {
      title: `Agent question — ${wsName}`,
      body: `${target.question.taskTitle}: ${target.question.question.text}`,
    };
  }
  const kind = target.run.failure?.kind.replace(/_/g, " ") ?? "failure";
  return {
    title: `Run needs recovery — ${wsName}`,
    body: `${kind}: ${target.run.prompt.slice(0, 140)}`,
  };
}

function runSubject(run: AgentRun, projects: readonly ProjectEntry[] | undefined): string {
  if (run.taskId) {
    for (const { project } of projects ?? []) {
      const task = project.tasks.find((item) => item.id === run.taskId);
      if (task) return task.title;
    }
  }
  if (run.agentId) return run.agentId;
  const headline = run.prompt.split("\n").find((line) => line.trim())?.trim();
  return headline?.slice(0, 80) || "Agent run";
}

function describeSettledRun(
  run: AgentRun,
  failed: boolean,
  wsName: string,
  projects: readonly ProjectEntry[] | undefined,
): { title: string; body: string } {
  return {
    title: `${runSubject(run, projects)} finished — ready for review`,
    body: failed
      ? `${wsName}: the run failed; open Crystal to inspect the result.`
      : `${wsName}: the agent run completed successfully.`,
  };
}

function describeWorkflowPause(
  workflow: Workflow,
  wsName: string,
): { title: string; body: string } {
  const fallback =
    workflow.pausedBy === "budget"
      ? "The workflow reached its budget limit."
      : "The workflow stalled after repeated turns without progress.";
  return {
    title: `Workflow paused — ${workflow.name}`,
    body: `${wsName}: ${workflow.pausedReason?.trim() || fallback}`,
  };
}

/** How many simultaneous arrivals collapse into one summary toast. */
const SUMMARY_THRESHOLD = 4;

export function useAttentionNotifications(): void {
  const { rows } = useFleetNeedsYou();
  const projectsByWs = useFleet((s) => s.projectsByWs);
  const jump = useAttentionJump();
  const { activeSid } = useCrystal();
  const activeWsId = useWorkspaces((s) => s.activeId);
  const workspaces = useWorkspaces((s) => s.workspaces);
  const workflows = useWorkflows((s) => s.workflows);
  const workflowsReadForWs = useWorkflows((s) => s.workflowsReadForWs);
  const notifyAttention = useSettings((s) => s.notifyAttention);
  const notifyRunsSettled = useSettings((s) => s.notifyRunsSettled);
  const notifyWorkflowPaused = useSettings((s) => s.notifyWorkflowPaused);
  const mode = useNav((l) => l.mode);
  const selectedThread = useNav((l) => l.threads?.thread);

  const trackerRef = useRef<AttentionTracker | null>(null);
  const tracker = (trackerRef.current ??= new AttentionTracker());
  const pauseTrackerRef = useRef<ActiveTransitionTracker | null>(null);
  const pauseTracker = (pauseTrackerRef.current ??= new ActiveTransitionTracker());

  // The scan effect keys on `rows` alone; everything it merely *consults*
  // (jump, the on-screen check) rides refs so a selection change can never
  // replay a scan.
  const jumpRef = useRef(jump);
  jumpRef.current = jump;
  const projectsByWsRef = useRef(projectsByWs);
  projectsByWsRef.current = projectsByWs;
  const settingsRef = useRef({
    notifyAttention,
    notifyRunsSettled,
    notifyWorkflowPaused,
  });
  settingsRef.current = { notifyAttention, notifyRunsSettled, notifyWorkflowPaused };
  const activeWsNameRef = useRef("Workspace");
  activeWsNameRef.current =
    workspaces.find((workspace) => workspace.id === activeWsId)?.name ?? "Workspace";
  const onScreenRef = useRef<(target: AttentionTarget) => boolean>(() => false);
  onScreenRef.current = (target) => {
    if (typeof document === "undefined" || !document.hasFocus()) return false;
    if (!activeWsId || wsKey(target.sid, target.ws) !== wsKey(activeSid, activeWsId)) return false;
    if (mode !== "threads") return false;
    // A thread selection is "any run id in the chain", so exact-id equality is
    // the conservative check: a mismatch may still be on screen (another turn
    // of the same chain), but a false "on screen" would swallow the toast.
    if (target.kind === "question") {
      return target.question.question.runId != null && selectedThread === target.question.question.runId;
    }
    // Workflows have no dedicated surface anymore — never suppress the pause toast.
    if (target.kind === "workflow") return false;
    return selectedThread === target.run.id;
  };

  // Desktop click-to-jump: the shell's notifier echoes the clicked toast's
  // target on this event (after focusing the window Rust-side); replay the
  // same jump the web Notification onclick performs.
  useEffect(() => {
    if (!inTauriWebview()) return;
    let unlisten: (() => void) | null = null;
    let disposed = false;
    void (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        const off = await listen<AttentionTarget>("attention-clicked", (event) => {
          jumpRef.current(event.payload);
        });
        if (disposed) off();
        else unlisten = off;
      } catch {
        /* event API unavailable in this shell — clicks just focus */
      }
    })();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    const freshAttention: { target: NeedsYouTarget; wsName: string }[] = [];
    const freshReviews: {
      target: Extract<AttentionTarget, { kind: "run" }>;
      wsName: string;
      failed: boolean;
    }[] = [];
    for (const row of rows) {
      // Absent slices are "not read yet": feeding them would seed on nothing
      // and then announce the real initial state as a transition.
      if (row.questionsRead) {
        const questions = row.actionableQuestions;
        const newIds = new Set(
          tracker.next(
            `${row.key}:questions`,
            questions.map((q) => questionAttentionId(q.question)),
          ),
        );
        for (const q of questions) {
          if (newIds.has(questionAttentionId(q.question))) {
            freshAttention.push({
              target: { kind: "question", sid: row.sid, ws: row.ws, question: q },
              wsName: row.name,
            });
          }
        }
      }
      if (row.runsRead) {
        const newIds = new Set(
          tracker.next(`${row.key}:failures`, row.failures.map(failureAttentionId)),
        );
        for (const run of row.failures) {
          if (newIds.has(failureAttentionId(run))) {
            freshAttention.push({
              target: { kind: "failure", sid: row.sid, ws: row.ws, run },
              wsName: row.name,
            });
          }
        }

        // Failures run first and share the same run identity as review
        // candidates, so terminal events that gain classification in stages
        // can never produce two notifications for one run.
        const reviews = settledRunReviews(row.runs);
        const reviewRuns = [...reviews.review, ...reviews.reviewFailed];
        const reviewFailedIds = new Set(reviews.reviewFailed.map(runAttentionId));
        const newReviewIds = new Set(
          tracker.next(`${row.key}:reviews`, reviewRuns.map(runAttentionId)),
        );
        for (const run of reviewRuns) {
          const id = runAttentionId(run);
          if (newReviewIds.has(id)) {
            freshReviews.push({
              target: { kind: "run", sid: row.sid, ws: row.ws, run },
              wsName: row.name,
              failed: reviewFailedIds.has(id),
            });
          }
        }
      }
    }

    const attentionToAnnounce = freshAttention.filter(
      ({ target }) => !onScreenRef.current(target),
    );
    if (settingsRef.current.notifyAttention && attentionToAnnounce.length >= SUMMARY_THRESHOLD) {
      // A burst (a manager filing questions across five tasks) is one toast.
      const first = attentionToAnnounce[0]!;
      void deliver(
        "Crystal needs you",
        `${attentionToAnnounce.length} new items are waiting across your workspaces`,
        first.target,
        () => jumpRef.current(first.target),
      );
    } else if (settingsRef.current.notifyAttention) {
      for (const { target, wsName } of attentionToAnnounce) {
        const { title, body } = describeAttention(target, wsName);
        void deliver(title, body, target, () => jumpRef.current(target));
      }
    }

    const reviewsToAnnounce = freshReviews.filter(({ target }) => !onScreenRef.current(target));
    if (settingsRef.current.notifyRunsSettled && reviewsToAnnounce.length >= SUMMARY_THRESHOLD) {
      const first = reviewsToAnnounce[0]!;
      void deliver(
        "Agent runs finished — ready for review",
        `${reviewsToAnnounce.length} runs finished across your workspaces`,
        first.target,
        () => jumpRef.current(first.target),
      );
    } else if (settingsRef.current.notifyRunsSettled) {
      for (const { target, wsName, failed } of reviewsToAnnounce) {
        const { title, body } = describeSettledRun(
          target.run,
          failed,
          wsName,
          projectsByWsRef.current[wsKey(target.sid, target.ws)],
        );
        void deliver(title, body, target, () => jumpRef.current(target));
      }
    }
  }, [rows, tracker]);

  useEffect(() => {
    // An empty initial store is unread, not a real snapshot. Feeding it would
    // turn existing pauses returned by refresh into false transitions.
    if (!activeWsId || workflowsReadForWs !== activeWsId) return;
    const automaticIds = automaticWorkflowPauseIds(workflows);
    const newIds = new Set(
      pauseTracker.next(`${wsKey(activeSid, activeWsId)}:workflow-pauses`, automaticIds),
    );
    if (!settingsRef.current.notifyWorkflowPaused || newIds.size === 0) return;
    for (const workflow of workflows) {
      if (!newIds.has(workflowPauseAttentionId(workflow))) continue;
      const target: AttentionTarget = {
        kind: "workflow",
        sid: activeSid,
        ws: activeWsId,
        workflowId: workflow.id,
      };
      if (onScreenRef.current(target)) continue;
      const { title, body } = describeWorkflowPause(workflow, activeWsNameRef.current);
      void deliver(title, body, target, () => jumpRef.current(target));
    }
  }, [activeSid, activeWsId, pauseTracker, workflows, workflowsReadForWs]);
}

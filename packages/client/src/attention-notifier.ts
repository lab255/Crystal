import { useEffect, useRef } from "react";
import {
  AttentionTracker,
  failureAttentionId,
  questionAttentionId,
} from "@crystal/core";
import { wsKey } from "./fleet-client.js";
import { useCrystal, useNav, useWorkspaces } from "./provider.js";
import {
  useAttentionJump,
  useFleetNeedsYou,
  type AttentionTarget,
} from "./fleet-needs-you.js";

/**
 * Desktop/browser notification on the *transition* into attention — a new open
 * question or a newly classified recoverable failure, anywhere in the fleet
 * (operator-oss's useOrchestrator seeding pattern). The what-counts policy is
 * `useFleetNeedsYou`; the when-to-announce policy is `AttentionTracker`
 * (@crystal/core needs-you.ts): each workspace's question list and run list
 * seed silently on their first read, so a page reload or a workspace opening
 * never re-announces what was already waiting. The item currently on screen is
 * skipped — if you are looking at the task (or run) in a focused window, the
 * toast would only echo the UI.
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

function describe(target: AttentionTarget, wsName: string): { title: string; body: string } {
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

/** How many simultaneous arrivals collapse into one summary toast. */
const SUMMARY_THRESHOLD = 4;

export function useAttentionNotifications(): void {
  const { rows } = useFleetNeedsYou();
  const jump = useAttentionJump();
  const { activeSid } = useCrystal();
  const activeWsId = useWorkspaces((s) => s.activeId);
  const mode = useNav((l) => l.mode);
  const selectedTab = useNav((l) => l.orchestrate?.tab);
  const selectedTask = useNav((l) => l.orchestrate?.task);
  const selectedRun = useNav((l) => l.orchestrate?.run);

  const trackerRef = useRef<AttentionTracker | null>(null);
  const tracker = (trackerRef.current ??= new AttentionTracker());

  // The scan effect keys on `rows` alone; everything it merely *consults*
  // (jump, the on-screen check) rides refs so a selection change can never
  // replay a scan.
  const jumpRef = useRef(jump);
  jumpRef.current = jump;
  const onScreenRef = useRef<(target: AttentionTarget) => boolean>(() => false);
  onScreenRef.current = (target) => {
    if (typeof document === "undefined" || !document.hasFocus()) return false;
    if (!activeWsId || wsKey(target.sid, target.ws) !== wsKey(activeSid, activeWsId)) return false;
    if (mode !== "orchestrate") return false;
    if (target.kind === "question") {
      // The board is the default tab, so an unset tab still shows the task.
      return (
        (selectedTab === "board" || selectedTab === undefined) &&
        selectedTask === target.question.taskId
      );
    }
    return selectedTab === "runs" && selectedRun === target.run.id;
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
    const fresh: { target: AttentionTarget; wsName: string }[] = [];
    for (const row of rows) {
      // Absent slices are "not read yet": feeding them would seed on nothing
      // and then announce the real initial state as a transition.
      if (row.questionsRead) {
        const newIds = new Set(
          tracker.next(
            `${row.key}:questions`,
            row.questions.map((q) => questionAttentionId(q.question)),
          ),
        );
        for (const q of row.questions) {
          if (newIds.has(questionAttentionId(q.question))) {
            fresh.push({
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
            fresh.push({
              target: { kind: "failure", sid: row.sid, ws: row.ws, run },
              wsName: row.name,
            });
          }
        }
      }
    }
    const toAnnounce = fresh.filter(({ target }) => !onScreenRef.current(target));
    if (toAnnounce.length === 0) return;
    if (toAnnounce.length >= SUMMARY_THRESHOLD) {
      // A burst (a manager filing questions across five tasks) is one toast.
      const first = toAnnounce[0]!;
      void deliver(
        "Crystal needs you",
        `${toAnnounce.length} new items are waiting across your workspaces`,
        first.target,
        () => jumpRef.current(first.target),
      );
      return;
    }
    for (const { target, wsName } of toAnnounce) {
      const { title, body } = describe(target, wsName);
      void deliver(title, body, target, () => jumpRef.current(target));
    }
  }, [rows, tracker]);
}

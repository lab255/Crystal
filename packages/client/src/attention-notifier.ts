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
 * (which has no web Notification support) the notification plugin, loaded
 * dynamically like the updater so the browser build never fetches it.
 * Permission is requested lazily on the first announcement, never at startup.
 */

/** True only inside the Tauri webview (same probe as desktop-update.ts). */
function inTauriWebview(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as unknown as Record<string, unknown>;
  return "__TAURI_INTERNALS__" in w || "isTauri" in w || "__TAURI__" in w;
}

async function deliver(title: string, body: string, onClick: () => void): Promise<void> {
  if (inTauriWebview()) {
    try {
      const plugin = await import("@tauri-apps/plugin-notification");
      let granted = await plugin.isPermissionGranted();
      if (!granted) granted = (await plugin.requestPermission()) === "granted";
      // Click-to-jump isn't wired on desktop — the plugin has no click
      // callback on desktop platforms; the pill is the navigation surface.
      if (granted) plugin.sendNotification({ title, body });
    } catch {
      /* plugin missing from this shell build — stay silent */
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
        () => jumpRef.current(first.target),
      );
      return;
    }
    for (const { target, wsName } of toAnnounce) {
      const { title, body } = describe(target, wsName);
      void deliver(title, body, () => jumpRef.current(target));
    }
  }, [rows, tracker]);
}

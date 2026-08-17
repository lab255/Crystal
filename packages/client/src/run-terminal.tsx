import { useEffect, useState } from "react";
import type { AgentRun } from "@crystal/core";
import { cn } from "@crystal/ui";
import { useCrystal, useTerminals, useWorkspaces } from "./provider.js";
import { XtermView } from "./xterm-view.js";

/**
 * An interactive run's PTY embedded where a headless run shows its transcript,
 * so watching the session never requires leaving the run view. Renders the
 * SAME server terminal as the bottom panel's tab — one shared TerminalTab in
 * the terminals store, each view its own xterm instance over the one chunk
 * stream — so typing or resizing in either place is live in the other.
 * Exited terminals stay listed server-side, so a settled run still shows its
 * scrollback; only a killed terminal leaves nothing to render.
 */
export function InteractiveRunTerminal({
  run,
  className,
}: {
  run: AgentRun;
  className?: string;
}) {
  const { activeSid } = useCrystal();
  const activeWs = useWorkspaces((s) => s.activeId);
  // Hub-owned runs carry the hosting workspace; workspace runs live where
  // the viewer already is (same resolution as InteractiveRunBanner).
  const ws = run.terminalWs ?? activeWs;
  const terminalId = run.terminalId ?? null;
  const tab = useTerminals((s) =>
    terminalId ? (s.tabs.find((t) => t.sid === activeSid && t.id === terminalId) ?? null) : null,
  );
  const ensureTerminal = useTerminals((s) => s.ensureTerminal);

  // Sync the tab + replay buffer without revealing the bottom panel. When the
  // refresh lands and the tab is still absent, the terminal is gone for good
  // (killed) — say so instead of pretending to connect forever.
  const [gone, setGone] = useState(false);
  useEffect(() => {
    if (tab || !ws || !terminalId) return;
    let cancelled = false;
    void ensureTerminal(ws, terminalId, activeSid)
      .then(() => {
        if (!cancelled) setGone(true);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [tab, ws, terminalId, activeSid, ensureTerminal]);

  // A LIVE run with a confirmed-missing terminal is an orphan (the composer
  // is hidden for live interactive runs, so "Connecting…" forever is a dead
  // end). Grace period first: right after spawn the terminal can list a beat
  // behind the run.
  const [orphaned, setOrphaned] = useState(false);
  useEffect(() => {
    if (!gone || tab) {
      setOrphaned(false);
      return;
    }
    const timer = setTimeout(() => setOrphaned(true), 8000);
    return () => clearTimeout(timer);
  }, [gone, tab, run.id]);

  if (!terminalId) return null;
  return (
    <div className={cn("min-h-0 flex-1", className)}>
      {tab ? (
        <div className="h-full min-h-0 px-2 py-1">
          {/* Click-to-focus only: selecting a session must not hijack the
              keyboard mid-navigation. */}
          <XtermView tab={tab} autoFocus={false} />
        </div>
      ) : (
        <div className="flex h-full items-center justify-center text-xs text-ink-faint">
          {gone && run.status !== "running" && run.status !== "queued"
            ? "This session's terminal was closed — no transcript to show."
            : orphaned
              ? "The session's terminal is gone but the run still reads as live — cancel the run to recover it."
              : "Connecting to the session's terminal…"}
        </div>
      )}
    </div>
  );
}

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

  if (!terminalId) return null;
  return (
    <div className={cn("min-h-0 flex-1", className)}>
      {tab ? (
        <div className="h-full min-h-0 px-2 py-1">
          <XtermView tab={tab} />
        </div>
      ) : (
        <div className="flex h-full items-center justify-center text-xs text-ink-faint">
          {/* A live run's terminal may list a beat after spawn — keep waiting
              for the terminal.changed broadcast; only a settled run's absence
              is final. */}
          {gone && run.status !== "running" && run.status !== "queued"
            ? "This session's terminal was closed — no transcript to show."
            : "Connecting to the session's terminal…"}
        </div>
      )}
    </div>
  );
}

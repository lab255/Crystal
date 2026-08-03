import { useCallback, useEffect, useRef, useState } from "react";
import { Bot, ChevronDown, Plus, Square, TerminalSquare, X } from "lucide-react";
import {
  XtermView,
  useFleetConnections,
  useTerminals,
  type TermChunk,
  type TerminalTab,
} from "@crystal/client";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  StatusDot,
  Tooltip,
  cn,
} from "@crystal/ui";

/**
 * Bottom terminal panel — tabs span every open workspace of every connected
 * bridge server, so you can run commands or drive agents in one project while
 * looking at another. Two tab kinds: shells (server-hosted PTYs rendered with
 * xterm.js — interactive, shared live across every connected client) and
 * agent consoles (each prompt starts/resumes a Claude run in that workspace).
 * With more than one server, the + menu lists (server · workspace) pairs and
 * tab labels carry the server name.
 */
const PANEL_HEIGHT_KEY = "crystal.terminalPanel.height";
const PANEL_DEFAULT_HEIGHT = 256;
const PANEL_MIN_HEIGHT = 120;
/**
 * Keep some app visible above the panel however far it is dragged. Budgets for
 * the header + footer chrome (~60px) plus a usable strip of the nav column —
 * the shell clips overflow either way, this just keeps the drag range sane.
 */
const PANEL_MIN_APP_ABOVE = 240;

function clampPanelHeight(px: number): number {
  const max = Math.max(PANEL_MIN_HEIGHT, window.innerHeight - PANEL_MIN_APP_ABOVE);
  return Math.min(max, Math.max(PANEL_MIN_HEIGHT, Math.round(px)));
}

function loadPanelHeight(): number {
  const stored = Number(localStorage.getItem(PANEL_HEIGHT_KEY));
  // Clamped against the *current* window: a height dragged out on a large
  // display must not swallow the whole app when reopened on a small one.
  return clampPanelHeight(Number.isFinite(stored) && stored > 0 ? stored : PANEL_DEFAULT_HEIGHT);
}

/**
 * The drag handle on the panel's top edge. Pointer-capture drag (works past
 * the window edge), Escape-free: releasing anywhere commits, double-click
 * resets to the default height. The xterm panes below follow via their own
 * ResizeObserver → `terminal.resize` loop, so the PTY tracks every drag.
 */
function usePanelResize(): {
  height: number;
  onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
  reset: () => void;
} {
  const [height, setHeight] = useState<number>(() =>
    typeof window === "undefined" ? PANEL_DEFAULT_HEIGHT : loadPanelHeight(),
  );
  const persist = useCallback((px: number) => {
    setHeight(px);
    try {
      localStorage.setItem(PANEL_HEIGHT_KEY, String(px));
    } catch {
      /* storage full/blocked — the session keeps its size anyway */
    }
  }, []);

  // Shrinking the window re-clamps the display height (the handle sits at the
  // panel's top edge — off-screen, it could never be grabbed again). The
  // stored preference is left alone, so a temporary shrink doesn't lose it.
  useEffect(() => {
    const onResize = () => setHeight((h) => clampPanelHeight(h));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const startY = e.clientY;
      const startHeight = height;
      const target = e.currentTarget;
      target.setPointerCapture(e.pointerId);
      const onMove = (ev: PointerEvent) => {
        persist(clampPanelHeight(startHeight + (startY - ev.clientY)));
      };
      const onUp = () => {
        target.removeEventListener("pointermove", onMove);
        target.removeEventListener("pointerup", onUp);
        target.removeEventListener("pointercancel", onUp);
      };
      target.addEventListener("pointermove", onMove);
      target.addEventListener("pointerup", onUp);
      target.addEventListener("pointercancel", onUp);
    },
    [height, persist],
  );

  return { height, onPointerDown, reset: () => persist(PANEL_DEFAULT_HEIGHT) };
}

export function TerminalPanel({ onClose }: { onClose: () => void }) {
  const tabs = useTerminals((s) => s.tabs);
  const activeTabId = useTerminals((s) => s.activeTabId);
  const setActive = useTerminals((s) => s.setActive);
  const openShell = useTerminals((s) => s.openShell);
  const openAgentConsole = useTerminals((s) => s.openAgentConsole);
  const closeTab = useTerminals((s) => s.closeTab);
  const connections = useFleetConnections();
  const multiServer = connections.length > 1;

  const wsName = (sid: string, id: string) => {
    const conn = connections.find((c) => c.sid === sid);
    const name = conn?.workspaces.find((w) => w.id === id)?.name ?? id;
    return multiServer && conn ? `${conn.label} · ${name}` : name;
  };
  // Every (server, workspace) pair the + menu can open a terminal into.
  const targets = connections.flatMap((c) =>
    c.state === "open"
      ? c.workspaces.map((w) => ({
          sid: c.sid,
          ws: w.id,
          label: multiServer ? `${c.label} · ${w.name}` : w.name,
        }))
      : [],
  );
  const active = tabs.find((t) => t.id === activeTabId) ?? null;
  const resize = usePanelResize();

  return (
    <div
      style={{ height: resize.height }}
      className="relative flex shrink-0 flex-col border-t border-edge bg-surface-1"
    >
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize terminal panel"
        onPointerDown={resize.onPointerDown}
        onDoubleClick={resize.reset}
        className="absolute inset-x-0 -top-1 z-10 h-2 cursor-row-resize touch-none hover:bg-crystal-500/30 active:bg-crystal-500/40"
      />
      <div className="flex h-8 shrink-0 items-center gap-0.5 border-b border-edge px-1.5">
        <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
          {tabs.map((t) => {
            const Icon = t.kind === "agent" ? Bot : TerminalSquare;
            return (
              <div
                key={t.id}
                className={cn(
                  "group/tab flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-[11px]",
                  t.id === activeTabId
                    ? "bg-surface-3 text-ink"
                    : "text-ink-faint hover:bg-surface-2 hover:text-ink-muted",
                )}
                onClick={() => setActive(t.id)}
              >
                <Icon className="h-3 w-3" />
                <span className="max-w-40 truncate">
                  {t.title
                    ? `${t.title} — ${wsName(t.sid, t.ws)}`
                    : `${wsName(t.sid, t.ws)}${t.kind === "shell" && t.cwd !== "." ? `/${t.cwd}` : ""}`}
                </span>
                {t.kind === "agent" && t.activeRunId ? (
                  <StatusDot status="running" />
                ) : t.status === "exited" ? (
                  <StatusDot status="idle" />
                ) : null}
                <button
                  type="button"
                  aria-label="Close terminal"
                  onClick={(e) => {
                    e.stopPropagation();
                    void closeTab(t.id);
                  }}
                  className="rounded p-0.5 opacity-0 hover:bg-surface-3 hover:text-danger group-hover/tab:opacity-100"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            );
          })}
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="New terminal"
              className="rounded p-1 text-ink-faint hover:bg-surface-3 hover:text-ink"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-56">
            {targets.map((t) => (
              <DropdownMenuItem
                key={`sh-${t.sid}-${t.ws}`}
                onSelect={() => void openShell(t.ws, undefined, undefined, undefined, t.sid)}
                className="gap-2"
              >
                <TerminalSquare className="h-3.5 w-3.5 text-ink-faint" />
                <span className="min-w-0 flex-1 truncate">Terminal — {t.label}</span>
              </DropdownMenuItem>
            ))}
            {targets.map((t) => (
              <DropdownMenuItem
                key={`ag-${t.sid}-${t.ws}`}
                onSelect={() => openAgentConsole(t.ws, t.sid)}
                className="gap-2"
              >
                <Bot className="h-3.5 w-3.5 text-ink-faint" />
                <span className="min-w-0 flex-1 truncate">Agent console — {t.label}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <Tooltip content="Hide panel" shortcut="Ctrl+`">
          <button
            type="button"
            aria-label="Hide terminal panel"
            onClick={onClose}
            className="rounded p-1 text-ink-faint hover:bg-surface-3 hover:text-ink"
          >
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
        </Tooltip>
      </div>

      {active ? (
        active.kind === "shell" ? (
          <div key={active.id} className="min-h-0 flex-1 px-2 py-1">
            <XtermView tab={active} />
          </div>
        ) : (
          <AgentConsoleView key={active.id} tab={active} />
        )
      ) : (
        <div className="flex flex-1 items-center justify-center text-xs text-ink-faint">
          No terminals — open one with{" "}
          <Plus className="mx-1 inline h-3 w-3" /> for any project.
        </div>
      )}
    </div>
  );
}

const STREAM_STYLES: Record<TermChunk["stream"], string> = {
  stdout: "text-ink",
  stderr: "text-danger",
  input: "text-crystal-300 font-semibold",
  system: "text-ink-faint italic",
};

function AgentConsoleView({ tab }: { tab: TerminalTab }) {
  const chunks = useTerminals((s) => s.chunksByTab[tab.id]);
  const send = useTerminals((s) => s.send);
  const cancelAgent = useTerminals((s) => s.cancelAgent);
  const [line, setLine] = useState("");
  const [error, setError] = useState<string | null>(null);
  const historyRef = useRef<string[]>([]);
  const historyIdxRef = useRef(-1);
  const scrollRef = useRef<HTMLDivElement>(null);

  const count = chunks?.length ?? 0;
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [count]);

  async function submit() {
    const text = line;
    if (!text.trim()) return;
    setLine("");
    setError(null);
    historyRef.current.push(text);
    historyIdxRef.current = historyRef.current.length;
    try {
      await send(tab.id, text);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const busy = tab.activeRunId != null;
  const dead = tab.status === "exited";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed">
          {(chunks ?? []).map((c) => (
            <span key={c.seq} className={STREAM_STYLES[c.stream]}>
              {c.stream === "input" ? `❯ ${c.text}` : c.text}
            </span>
          ))}
        </pre>
      </div>
      {error ? <div className="px-3 pb-1 text-[10px] text-danger">{error}</div> : null}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="flex shrink-0 items-center gap-2 border-t border-edge px-3 py-1.5"
      >
        <span className="font-mono text-[11px] text-crystal-300">✦</span>
        <input
          value={line}
          onChange={(e) => setLine(e.target.value)}
          onKeyDown={(e) => {
            const history = historyRef.current;
            if (e.key === "ArrowUp" && history.length > 0) {
              e.preventDefault();
              historyIdxRef.current = Math.max(0, historyIdxRef.current - 1);
              setLine(history[historyIdxRef.current] ?? "");
            } else if (e.key === "ArrowDown" && history.length > 0) {
              e.preventDefault();
              historyIdxRef.current = Math.min(history.length, historyIdxRef.current + 1);
              setLine(history[historyIdxRef.current] ?? "");
            }
          }}
          placeholder={
            dead ? "console closed" : busy ? "agent is working…" : "Prompt the agent in this project…"
          }
          disabled={dead || busy}
          spellCheck={false}
          className="min-w-0 flex-1 bg-transparent font-mono text-[11px] text-ink outline-none placeholder:text-ink-faint disabled:opacity-50"
        />
        {busy ? (
          <Tooltip content="Cancel the running agent">
            <button
              type="button"
              aria-label="Cancel agent run"
              onClick={() => void cancelAgent(tab.id)}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-danger hover:bg-surface-3"
            >
              <Square className="h-3 w-3" /> Stop
            </button>
          </Tooltip>
        ) : null}
      </form>
    </div>
  );
}

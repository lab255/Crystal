import { useEffect, useRef, useState } from "react";
import { Bot, ChevronDown, Plus, Square, TerminalSquare, X } from "lucide-react";
import { useTerminals, useWorkspaces, type TermChunk, type TerminalTab } from "@crystal/client";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  StatusDot,
  Tooltip,
  cn,
} from "@crystal/ui";
import { XtermView } from "./XtermView.js";

/**
 * Bottom terminal panel — tabs span every open workspace, so you can run
 * commands or drive agents in one project while looking at another. Two tab
 * kinds: shells (server-hosted PTYs rendered with xterm.js — interactive,
 * shared live across every connected client) and agent consoles (each prompt
 * starts/resumes a Claude run in that workspace).
 */
export function TerminalPanel({ onClose }: { onClose: () => void }) {
  const tabs = useTerminals((s) => s.tabs);
  const activeTabId = useTerminals((s) => s.activeTabId);
  const setActive = useTerminals((s) => s.setActive);
  const openShell = useTerminals((s) => s.openShell);
  const openAgentConsole = useTerminals((s) => s.openAgentConsole);
  const closeTab = useTerminals((s) => s.closeTab);
  const workspaces = useWorkspaces((s) => s.workspaces);

  const wsName = (id: string) => workspaces.find((w) => w.id === id)?.name ?? id;
  const active = tabs.find((t) => t.id === activeTabId) ?? null;

  return (
    <div className="flex h-64 shrink-0 flex-col border-t border-edge bg-surface-1">
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
                  {wsName(t.ws)}
                  {t.kind === "shell" && t.cwd !== "." ? `/${t.cwd}` : ""}
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
            {workspaces.map((w) => (
              <DropdownMenuItem key={`sh-${w.id}`} onSelect={() => void openShell(w.id)} className="gap-2">
                <TerminalSquare className="h-3.5 w-3.5 text-ink-faint" />
                <span className="min-w-0 flex-1 truncate">Terminal — {w.name}</span>
              </DropdownMenuItem>
            ))}
            {workspaces.map((w) => (
              <DropdownMenuItem key={`ag-${w.id}`} onSelect={() => openAgentConsole(w.id)} className="gap-2">
                <Bot className="h-3.5 w-3.5 text-ink-faint" />
                <span className="min-w-0 flex-1 truncate">Agent console — {w.name}</span>
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

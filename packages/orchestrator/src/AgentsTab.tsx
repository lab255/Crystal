import { useState } from "react";
import { Bot, Play, Plus, Sparkles, UserCog, Wand2 } from "lucide-react";
import { RUN_PURPOSES, type RunPurpose } from "@crystal/core";
import { useAgents, useCrystal, useWorkspace } from "@crystal/client";
import { Button, EmptyState, Textarea, cn } from "@crystal/ui";
import { MANAGER_PREAMBLE } from "./prompt.js";
import { RunList } from "./RunList.js";
import { RunView } from "./RunView.js";

const selectClasses =
  "h-8 rounded-lg border border-edge bg-surface-1 px-2 text-[13px] text-ink " +
  "focus:border-crystal-500/60 focus:outline-none";

/**
 * The unified agent dispatch surface: a manager/worker composer plus one-click
 * job templates on the left of the run tree, the reusable {@link RunList}
 * sidepane in the middle, and live run output on the right. Every path in —
 * a typed prompt, a manager delegation, or a predefined template — produces an
 * {@link AgentRun} that streams into the same list.
 */
export function AgentsTab({
  selectedRunId,
  onSelectRun,
}: {
  selectedRunId: string | null;
  onSelectRun: (id: string | null) => void;
}) {
  const runs = useAgents((s) => s.runs);
  const selectedRun = runs.find((r) => r.id === selectedRunId) ?? null;

  return (
    <div className="flex h-full min-h-0">
      <RunList
        runs={runs}
        selectedRunId={selectedRunId}
        onSelect={onSelectRun}
        title="Agents"
        emptyHint="No agents dispatched yet. Start one on the right."
      />
      <main className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b border-edge px-3 py-1.5">
          <Button variant="ghost" size="sm" onClick={() => onSelectRun(null)}>
            <Plus className="h-3.5 w-3.5" /> New dispatch
          </Button>
          {selectedRun ? (
            <span className="truncate text-[11px] text-ink-faint">
              Viewing run · {selectedRun.status}
            </span>
          ) : null}
        </div>
        <div className="min-h-0 flex-1">
          {selectedRun ? (
            <RunView run={selectedRun} />
          ) : (
            <DispatchPanel onDispatched={onSelectRun} />
          )}
        </div>
      </main>
    </div>
  );
}

/** A predefined job, dispatched with one click and tracked like any run. */
interface JobTemplate {
  id: "index" | "review";
  label: string;
  hint: string;
  icon: typeof Sparkles;
}

const JOB_TEMPLATES: JobTemplate[] = [
  {
    id: "index",
    label: "Index intents",
    hint: "Tag changed symbols' intent",
    icon: Sparkles,
  },
  {
    id: "review",
    label: "Review working tree",
    hint: "Correctness + quality pass on the diff",
    icon: Wand2,
  },
];

const EMPTY_REPOS: never[] = [];

function DispatchPanel({ onDispatched }: { onDispatched: (id: string) => void }) {
  const { client } = useCrystal();
  const start = useAgents((s) => s.start);
  const repos = useWorkspace((s) => s.info?.manifest.repos ?? EMPTY_REPOS);

  const [prompt, setPrompt] = useState("");
  const [manager, setManager] = useState(true);
  const [purpose, setPurpose] = useState<RunPurpose>("implement");
  const [cwd, setCwd] = useState(".");
  const [isolate, setIsolate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const repoId = repos.find((r) => r.path === cwd)?.id ?? null;

  async function dispatch(): Promise<void> {
    const text = prompt.trim();
    if (!text) return;
    setBusy(true);
    setError(null);
    try {
      const run = await start({
        prompt: manager ? MANAGER_PREAMBLE + text : text,
        cwd,
        repoId,
        isolation: isolate ? "worktree" : "none",
        role: manager ? "manager" : null,
        purpose,
        tags: manager ? ["role:manager", `purpose:${purpose}`] : [`purpose:${purpose}`],
      });
      setPrompt("");
      onDispatched(run.id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function runTemplate(tpl: JobTemplate): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      if (tpl.id === "index") {
        const { run } = await client.request("codeindex.enrich", {});
        onDispatched(run.id);
      } else {
        const run = await start({
          prompt:
            "Review the current working-tree diff for correctness bugs and " +
            "quality issues (reuse, simplification, efficiency). List findings " +
            "with file:line and a short rationale each.",
          cwd,
          repoId,
          purpose: "code-review",
          tags: ["purpose:code-review"],
        });
        onDispatched(run.id);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto flex h-full w-full max-w-2xl flex-col gap-4 overflow-y-auto p-5">
      <div className="rounded-xl border border-crystal-500/25 bg-crystal-500/5 p-3">
        <div className="mb-2 flex items-center gap-2">
          <Bot className="h-4 w-4 text-crystal-300" />
          <span className="text-[13px] font-semibold text-ink">Dispatch an agent</span>
        </div>
        <Textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void dispatch();
          }}
          rows={5}
          placeholder={
            manager
              ? "Describe the goal — the manager will break it down and dispatch workers…"
              : "Describe the task for a single agent…"
          }
          aria-label="Agent prompt"
        />
        <label className="mt-2 flex cursor-pointer items-center gap-1.5 text-[11px] text-ink-muted">
          <input
            type="checkbox"
            checked={manager}
            onChange={(e) => setManager(e.target.checked)}
            className="h-3 w-3 accent-[var(--color-crystal-500)]"
          />
          <UserCog className="h-3.5 w-3.5" />
          Manager mode — delegate to worker agents
        </label>
        <div className="mt-2 flex items-center gap-2">
          <select
            className={cn(selectClasses, "h-7 flex-1 text-xs")}
            value={purpose}
            onChange={(e) => setPurpose(e.target.value as RunPurpose)}
            aria-label="Run purpose"
          >
            {RUN_PURPOSES.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          <select
            className={cn(selectClasses, "h-7 flex-1 text-xs")}
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            aria-label="Working directory"
          >
            <option value=".">workspace root</option>
            {repos
              .filter((r) => r.path !== ".")
              .map((r) => (
                <option key={r.id} value={r.path}>
                  {r.name}
                </option>
              ))}
          </select>
          <Button
            variant="primary"
            size="sm"
            disabled={busy || !prompt.trim()}
            onClick={() => void dispatch()}
          >
            <Play className="h-3 w-3" /> Dispatch
          </Button>
        </div>
        <label className="mt-2 flex cursor-pointer items-center gap-1.5 text-[11px] text-ink-muted">
          <input
            type="checkbox"
            checked={isolate}
            onChange={(e) => setIsolate(e.target.checked)}
            className="h-3 w-3 accent-[var(--color-crystal-500)]"
          />
          Isolate in a git worktree
          <span className="text-ink-faint">— parallel-safe, review the diff before applying</span>
        </label>
        {error ? <p className="mt-2 text-[11px] text-danger">{error}</p> : null}
      </div>

      <div>
        <h3 className="mb-1.5 px-1 text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
          Templates
        </h3>
        <div className="grid grid-cols-2 gap-2">
          {JOB_TEMPLATES.map((tpl) => (
            <button
              key={tpl.id}
              type="button"
              disabled={busy}
              onClick={() => void runTemplate(tpl)}
              className="flex items-start gap-2.5 rounded-xl border border-edge bg-surface-1 p-3 text-left transition-colors hover:border-edge-strong disabled:opacity-50"
            >
              <tpl.icon className="mt-0.5 h-4 w-4 shrink-0 text-crystal-300" />
              <span className="min-w-0">
                <span className="block text-[13px] font-semibold text-ink">{tpl.label}</span>
                <span className="block text-[11px] text-ink-faint">{tpl.hint}</span>
              </span>
            </button>
          ))}
        </div>
      </div>

      <EmptyState icon={Bot} title="One run tree">
        Manager runs, their workers, single agents and templates all stream into the list on
        the left.
      </EmptyState>
    </div>
  );
}

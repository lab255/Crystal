import { useEffect, useMemo, useState } from "react";
import { Bot, Play, TerminalSquare } from "lucide-react";
import {
  RUN_PURPOSES,
  matchAgent,
  nowIso,
  type Project,
  type RunPurpose,
  type TaskItem,
} from "@crystal/core";
import {
  useAgents,
  useCrystal,
  useTerminals,
  useWorkspace,
  useWorkspaces,
} from "@crystal/client";
import { Button, Select, Textarea } from "@crystal/ui";
import { buildTaskPrompt } from "./prompt.js";

/**
 * The "Run agent" dispatch card: editable prompt seeded from the task,
 * purpose/cwd/worktree options, and the two dispatch verbs — interactive
 * (native Claude TUI on a workspace PTY, the default) and headless
 * (stream-json in the background). Shared by the task-detail aside and the
 * task session hero; both patch the task's runIds and bump backlog →
 * in_progress on dispatch.
 */
export function RunAgentCard({
  project,
  task,
  onProjectChange,
  onOpenRun,
}: {
  project: Project;
  task: TaskItem;
  onProjectChange: (project: Project) => void;
  /** Called with the new headless run's id (interactive runs focus the terminal instead). */
  onOpenRun: (runId: string) => void;
}) {
  const info = useWorkspace((s) => s.info);
  const roster = useWorkspace((s) => s.roster);
  const startRun = useAgents((s) => s.start);
  const activeWs = useWorkspaces((s) => s.activeId);
  const focusTerminal = useTerminals((s) => s.focusTerminal);
  const { client } = useCrystal();

  const [prompt, setPrompt] = useState("");
  const [promptDirty, setPromptDirty] = useState(false);
  const [purpose, setPurpose] = useState<RunPurpose>("implement");
  const [cwd, setCwd] = useState(".");
  const [isolate, setIsolate] = useState(false);
  const [starting, setStarting] = useState(false);
  const [dispatchError, setDispatchError] = useState<string | null>(null);

  useEffect(() => {
    setPromptDirty(false);
    setDispatchError(null);
  }, [task.id]);

  const defaultPrompt = useMemo(() => buildTaskPrompt(task, info), [task, info]);
  const effectivePrompt = promptDirty ? prompt : defaultPrompt;

  // The dispatch target: the assigned agent, else the tag-matched one.
  const dispatchAgent =
    roster?.agents.find((a) => a.id === task.owners.agentId) ??
    (roster ? matchAgent(task.labels, roster) : null);

  function patchTask(patch: Partial<TaskItem>): void {
    onProjectChange({
      ...project,
      tasks: project.tasks.map((t) =>
        t.id === task.id ? { ...t, ...patch, updatedAt: nowIso() } : t,
      ),
    });
  }

  async function runAgent(): Promise<void> {
    setStarting(true);
    setDispatchError(null);
    try {
      const repoId = info?.manifest.repos.find((r) => r.path === cwd)?.id ?? null;
      const run = await startRun({
        prompt: effectivePrompt,
        cwd,
        taskId: task.id,
        projectId: project.id,
        repoId,
        isolation: isolate ? "worktree" : "none",
        agentId: dispatchAgent?.id ?? null,
        purpose,
        tags: task.labels,
      });
      patchTask({
        runIds: [...task.runIds, run.id],
        status: task.status === "backlog" ? "in_progress" : task.status,
      });
      onOpenRun(run.id);
    } catch (err) {
      setDispatchError((err as Error).message);
    } finally {
      setStarting(false);
    }
  }

  /**
   * Dispatch into the terminal panel instead: a native interactive Claude
   * session (AskUserQuestion works, decisions still logged via ask_question).
   */
  async function runInteractive(): Promise<void> {
    setStarting(true);
    setDispatchError(null);
    try {
      const repoId = info?.manifest.repos.find((r) => r.path === cwd)?.id ?? null;
      const { run, terminal } = await client.request("agent.interactive", {
        prompt: effectivePrompt,
        cwd,
        taskId: task.id,
        projectId: project.id,
        repoId,
        agentId: dispatchAgent?.id ?? null,
        purpose,
        tags: task.labels,
      });
      patchTask({
        runIds: [...task.runIds, run.id],
        status: task.status === "backlog" ? "in_progress" : task.status,
      });
      if (activeWs) await focusTerminal(activeWs, terminal.id);
    } catch (err) {
      setDispatchError((err as Error).message);
    } finally {
      setStarting(false);
    }
  }

  return (
    <div className="rounded-xl border border-crystal-500/25 bg-crystal-500/5 p-2.5">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-crystal-300">
          Run agent
        </span>
        {promptDirty ? (
          <button
            type="button"
            className="text-[10px] text-ink-faint underline hover:text-ink-muted"
            onClick={() => setPromptDirty(false)}
          >
            reset prompt
          </button>
        ) : null}
      </div>
      <Textarea
        value={effectivePrompt}
        onChange={(e) => {
          setPrompt(e.target.value);
          setPromptDirty(true);
        }}
        rows={5}
        className="font-mono text-[11px]"
        aria-label="Agent prompt"
      />
      <div className="mt-2 flex items-center gap-2">
        <Select
          size="sm"
          className="flex-1"
          value={purpose}
          onChange={(e) => setPurpose(e.target.value as RunPurpose)}
          aria-label="Run purpose"
        >
          {RUN_PURPOSES.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </Select>
        <Select
          size="sm"
          className="flex-1"
          value={cwd}
          onChange={(e) => setCwd(e.target.value)}
          aria-label="Working directory"
        >
          <option value=".">workspace root</option>
          {info?.manifest.repos
            .filter((r) => r.path !== ".")
            .map((r) => (
              <option key={r.id} value={r.path}>
                {r.name}
              </option>
            ))}
        </Select>
        {/* Interactive is the default dispatch: the native TUI in the
            terminal panel, questions answered in place. Headless stays a
            click away for fire-and-forget runs. */}
        <Button
          variant="primary"
          size="sm"
          disabled={starting || !effectivePrompt.trim()}
          onClick={() => void runInteractive()}
          title="Run as a native interactive Claude session in the terminal panel — answer its questions there (or later from the board, where they are still logged)"
        >
          <TerminalSquare className="h-3 w-3" /> Run
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={starting || !effectivePrompt.trim()}
          onClick={() => void runAgent()}
          title="Run headless (stream-json in the background) — watch it right here, no terminal"
        >
          <Play className="h-3 w-3" /> Headless
        </Button>
      </div>
      {dispatchError ? <p className="mt-1.5 text-[11px] text-danger">{dispatchError}</p> : null}
      <div className="mt-1.5 flex items-center gap-1 text-[11px] text-ink-muted">
        <Bot className="h-3 w-3 shrink-0" />
        {dispatchAgent
          ? `Dispatches to ${dispatchAgent.name} (${dispatchAgent.model}${
              dispatchAgent.skills.length ? ` + ${dispatchAgent.skills.join(", ")}` : ""
            })`
          : "No agent profile — CLI default model"}
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
    </div>
  );
}

import { useEffect, useMemo, useState } from "react";
import { Bot, CircleHelp, ExternalLink, Lock, Play, Send, TerminalSquare, Trash2, X } from "lucide-react";
import {
  RUN_PURPOSES,
  TASK_SIZES,
  TASK_STATUSES,
  TASK_STATUS_LABELS,
  apiRatePerMin,
  createEpic,
  leaseValid,
  matchAgent,
  nowIso,
  openQuestions,
  rollupRunsUsage,
  taskLiveUsage,
  type Project,
  type RunPurpose,
  type TaskItem,
  type TaskPriority,
  type TaskQuestion,
  type TaskSize,
  type TaskStatus,
} from "@crystal/core";
import {
  formatRunCost,
  formatRunTokens,
  useAgents,
  useCrystal,
  useTerminals,
  useWorkspace,
  useWorkspaces,
} from "@crystal/client";
import { Badge, Button, Field, Select, StatusDot, Textarea, cn } from "@crystal/ui";
import { buildTaskPrompt } from "./prompt.js";

// Text inputs styled to sit flush beside the shared <Select> fields.
const inputClasses =
  "w-full h-8 rounded-lg border border-edge bg-surface-1 px-2 text-[13px] text-ink " +
  "focus:border-crystal-500/60 focus:outline-none";

const NEW_EPIC = "__new_epic__";

export function TaskDetail({
  project,
  projectPath,
  task,
  onProjectChange,
  onClose,
  onOpenRun,
}: {
  project: Project;
  projectPath: string;
  task: TaskItem;
  onProjectChange: (project: Project) => void;
  onClose: () => void;
  onOpenRun: (runId: string) => void;
}) {
  const info = useWorkspace((s) => s.info);
  const roster = useWorkspace((s) => s.roster);
  const runs = useAgents((s) => s.runs);
  const startRun = useAgents((s) => s.start);
  const activeWs = useWorkspaces((s) => s.activeId);
  const focusTerminal = useTerminals((s) => s.focusTerminal);
  const { client } = useCrystal();

  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description);
  const [human, setHuman] = useState(task.owners.human ?? "");
  const [tagDraft, setTagDraft] = useState("");
  const [epicDraft, setEpicDraft] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [promptDirty, setPromptDirty] = useState(false);
  const [purpose, setPurpose] = useState<RunPurpose>("implement");
  const [cwd, setCwd] = useState(".");
  const [isolate, setIsolate] = useState(false);
  const [starting, setStarting] = useState(false);
  const [dispatchError, setDispatchError] = useState<string | null>(null);

  useEffect(() => {
    setTitle(task.title);
    setDescription(task.description);
    setHuman(task.owners.human ?? "");
    setPromptDirty(false);
    setEpicDraft(null);
    setTagDraft("");
  }, [task.id]);

  const defaultPrompt = useMemo(() => buildTaskPrompt(task, info), [task, info]);
  const effectivePrompt = promptDirty ? prompt : defaultPrompt;

  const taskRuns = runs.filter((r) => r.taskId === task.id);
  const rollup = useMemo(() => rollupRunsUsage(taskRuns), [taskRuns]);
  const callRate = apiRatePerMin(rollup.usage, rollup.activeMs);
  // Durable rollup + live runs — run history in app data ages out, the board's
  // rollup doesn't, so the runs list alone undercounts.
  const liveUsage = useMemo(() => taskLiveUsage(task, runs), [task, runs]);

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

  function deleteTask(): void {
    onProjectChange({ ...project, tasks: project.tasks.filter((t) => t.id !== task.id) });
    onClose();
  }

  function addTag(): void {
    const tag = tagDraft.trim();
    if (!tag || task.labels.includes(tag)) {
      setTagDraft("");
      return;
    }
    patchTask({ labels: [...task.labels, tag] });
    setTagDraft("");
  }

  function createNewEpic(name: string): void {
    const epic = createEpic(name);
    onProjectChange({
      ...project,
      epics: [...project.epics, epic],
      tasks: project.tasks.map((t) =>
        t.id === task.id ? { ...t, epicId: epic.id, updatedAt: nowIso() } : t,
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

  /**
   * Record the answer server-side and hand it back to the asking session via
   * `deliver`: an idle chain resumes, a busy one gets it queued, and an
   * interactive terminal session has it typed in — resuming the session here
   * directly (the old path) would fork it whenever the asker was mid-turn.
   */
  async function answerQuestion(question: TaskQuestion, answer: string): Promise<void> {
    const result = await client.request("task.answer", {
      path: projectPath,
      taskId: task.id,
      questionId: question.id,
      answer,
    });
    if (!result.ok) throw new Error(result.reason);
    // Reflect the answer locally too: board props don't refetch on
    // workspace.changed, so without this the row keeps rendering open — and
    // worse, any later edit from this stale snapshot would whole-project-save
    // `answer: null` back over the server's record (newest-updatedAt merge),
    // silently reopening a question whose asker already consumed the answer.
    patchTask({
      questions: task.questions.map((q) =>
        q.id === question.id ? { ...q, answer, answeredAt: nowIso() } : q,
      ),
    });
    if (result.resumedRunId) onOpenRun(result.resumedRunId);
  }

  return (
    <aside className="flex w-[340px] shrink-0 flex-col border-l border-edge bg-surface-1">
      <div className="flex items-center justify-between border-b border-edge px-3 py-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
          Task
        </span>
        <div className="flex gap-1">
          <Button variant="ghost" size="icon-sm" onClick={deleteTask} aria-label="Delete task">
            <Trash2 className="h-3.5 w-3.5 text-danger" />
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close task detail">
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-3.5 overflow-y-auto p-3">
        <Textarea
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => title.trim() && patchTask({ title: title.trim() })}
          rows={2}
          className="text-sm font-semibold"
          aria-label="Task title"
        />

        {leaseValid(task.lease) ? (
          <div className="flex items-center gap-2 rounded-lg border border-info/30 bg-info/5 px-2 py-1.5 text-[11px] text-ink-muted">
            <Lock className="h-3.5 w-3.5 shrink-0 text-info" />
            <span
              className="min-w-0 flex-1 truncate"
              title="One writer per task. The board is yours: edits you make here override the agent's lease."
            >
              Leased to <span className="text-ink">{task.lease!.holder}</span> until{" "}
              {new Date(task.lease!.expiresAt).toLocaleTimeString()} — your edits override it
            </span>
            <Button
              variant="ghost"
              size="xs"
              onClick={() =>
                void client.request("task.release", {
                  path: projectPath,
                  taskId: task.id,
                  force: true,
                })
              }
              title="Owner override: revoke the agent's write lease"
            >
              Release
            </Button>
          </div>
        ) : null}

        <div className="grid grid-cols-2 gap-2">
          <Field label="Status">
            <Select
              value={task.status}
              onChange={(e) => patchTask({ status: e.target.value as TaskStatus })}
            >
              {TASK_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {TASK_STATUS_LABELS[s]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Priority">
            <Select
              value={task.priority}
              onChange={(e) => patchTask({ priority: e.target.value as TaskPriority })}
            >
              {(["low", "medium", "high", "urgent"] as const).map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Size">
            <Select
              value={task.size ?? ""}
              onChange={(e) =>
                patchTask({ size: e.target.value ? (e.target.value as TaskSize) : null })
              }
            >
              <option value="">—</option>
              {TASK_SIZES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Epic">
            {epicDraft !== null ? (
              <input
                autoFocus
                value={epicDraft}
                onChange={(e) => setEpicDraft(e.target.value)}
                onBlur={() => {
                  if (epicDraft.trim()) createNewEpic(epicDraft.trim());
                  setEpicDraft(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                  else if (e.key === "Escape") setEpicDraft(null);
                }}
                placeholder="Epic name…"
                className={cn(inputClasses, "placeholder:text-ink-faint")}
                aria-label="New epic name"
              />
            ) : (
              <Select
                value={task.epicId ?? ""}
                onChange={(e) => {
                  if (e.target.value === NEW_EPIC) setEpicDraft("");
                  else patchTask({ epicId: e.target.value || null });
                }}
              >
                <option value="">—</option>
                {project.epics.map((epic) => (
                  <option key={epic.id} value={epic.id}>
                    {epic.name}
                  </option>
                ))}
                <option value={NEW_EPIC}>+ New epic…</option>
              </Select>
            )}
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <Field label="Agent owner">
            <Select
              className={cn(!task.owners.agentId && "text-warn")}
              value={task.owners.agentId ?? ""}
              onChange={(e) =>
                patchTask({ owners: { ...task.owners, agentId: e.target.value || null } })
              }
            >
              <option value="">auto (match tags)</option>
              {(roster?.agents ?? []).map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} · {a.model}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Human owner">
            <input
              value={human}
              onChange={(e) => setHuman(e.target.value)}
              onBlur={() => patchTask({ owners: { ...task.owners, human: human.trim() || null } })}
              placeholder={roster?.defaultHuman || "who's accountable?"}
              className={cn(inputClasses, !task.owners.human && "border-warn/40")}
              aria-label="Human owner"
            />
          </Field>
        </div>

        <Field label="Description">
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            onBlur={() => patchTask({ description })}
            rows={4}
            placeholder="Details, acceptance criteria…"
          />
        </Field>

        <Field label="Tags">
          <div className="flex flex-wrap items-center gap-1.5">
            {task.labels.map((label) => (
              <button
                key={label}
                type="button"
                title="Remove tag"
                onClick={() => patchTask({ labels: task.labels.filter((l) => l !== label) })}
              >
                <Badge className="cursor-pointer">{label} ×</Badge>
              </button>
            ))}
            <input
              value={tagDraft}
              onChange={(e) => setTagDraft(e.target.value)}
              onBlur={addTag}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addTag();
                }
              }}
              placeholder="dimension:value"
              className="h-6 w-28 rounded-md border border-edge bg-surface-1 px-1.5 text-[11px] text-ink outline-none placeholder:text-ink-faint focus:border-crystal-500/60"
              aria-label="Add tag"
            />
          </div>
        </Field>

        <Field label={`Blocked by${task.blockedBy.length ? ` (${task.blockedBy.length})` : ""}`}>
          <div className="space-y-1.5">
            {task.blockedBy.map((id) => {
              const blocker = project.tasks.find((t) => t.id === id);
              const open = blocker ? blocker.status !== "done" : false;
              return (
                <button
                  key={id}
                  type="button"
                  title="Remove dependency"
                  onClick={() =>
                    patchTask({ blockedBy: task.blockedBy.filter((b) => b !== id) })
                  }
                  className="flex w-full items-center gap-1.5 text-left"
                >
                  <Badge tone={open ? "amber" : "emerald"} className="max-w-full cursor-pointer">
                    <span className="truncate">
                      {blocker ? `${blocker.title} [${blocker.status}]` : `${id} (deleted)`} ×
                    </span>
                  </Badge>
                </button>
              );
            })}
            <Select
              size="sm"
              className="text-ink-muted"
              value=""
              onChange={(e) => {
                if (e.target.value) patchTask({ blockedBy: [...task.blockedBy, e.target.value] });
              }}
              aria-label="Add blocking task"
            >
              <option value="">+ Add dependency…</option>
              {project.tasks
                // No self-blocking, no duplicates, no direct cycles.
                .filter(
                  (t) =>
                    t.id !== task.id &&
                    !task.blockedBy.includes(t.id) &&
                    !t.blockedBy.includes(task.id),
                )
                .map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.title} [{t.status}]
                  </option>
                ))}
            </Select>
          </div>
        </Field>

        {info && info.manifest.repos.length > 0 ? (
          <Field label="Linked repos">
            <div className="flex flex-wrap gap-1.5">
              {info.manifest.repos.map((repo) => {
                const linked = task.links.repoIds.includes(repo.id);
                return (
                  <button
                    key={repo.id}
                    type="button"
                    onClick={() =>
                      patchTask({
                        links: {
                          ...task.links,
                          repoIds: linked
                            ? task.links.repoIds.filter((id) => id !== repo.id)
                            : [...task.links.repoIds, repo.id],
                        },
                      })
                    }
                  >
                    <Badge tone={linked ? "violet" : "neutral"} className="cursor-pointer">
                      {repo.name}
                    </Badge>
                  </button>
                );
              })}
            </div>
          </Field>
        ) : null}

        {info ? <NodeLinks task={task} patchTask={patchTask} /> : null}

        {task.questions.length > 0 ? (
          <Field label={`Questions (${openQuestions(task).length} open)`}>
            <div className="space-y-1.5">
              {task.questions.map((q) => (
                <QuestionRow key={q.id} question={q} onAnswer={answerQuestion} />
              ))}
            </div>
          </Field>
        ) : null}

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
              title="Run headless (stream-json in the background) — watch it from the Runs tab, no terminal"
            >
              <Play className="h-3 w-3" /> Headless
            </Button>
          </div>
          {dispatchError ? (
            <p className="mt-1.5 text-[11px] text-danger">{dispatchError}</p>
          ) : null}
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

        {liveUsage || taskRuns.length > 0 ? (
          <Field label="Cost to date">
            <div className="grid grid-cols-2 gap-x-3 gap-y-1 rounded-lg border border-edge bg-surface-2 px-2.5 py-2 text-[11px]">
              <span className="text-ink-faint">Cost</span>
              <span className="text-right text-ink">{formatRunCost(liveUsage?.costUsd)}</span>
              <span className="text-ink-faint">Tokens</span>
              <span className="text-right text-ink">{formatRunTokens(liveUsage?.tokens)}</span>
              <span className="text-ink-faint">API calls</span>
              <span className="text-right text-ink">{rollup.usage.apiCalls || "—"}</span>
              <span className="text-ink-faint">API rate</span>
              <span className="text-right text-ink">
                {callRate != null ? `${callRate.toFixed(1)}/min` : "—"}
              </span>
            </div>
          </Field>
        ) : null}

        {taskRuns.length > 0 ? (
          <Field label={`Runs (${taskRuns.length})`}>
            <div className="space-y-1">
              {taskRuns.map((run) => (
                <button
                  key={run.id}
                  type="button"
                  onClick={() => onOpenRun(run.id)}
                  className="flex w-full items-center gap-2 rounded-lg border border-edge bg-surface-2 px-2.5 py-1.5 text-left transition-colors hover:border-edge-strong"
                >
                  <StatusDot status={run.status} />
                  <span className="min-w-0 flex-1 truncate text-[11px] text-ink-muted">
                    {new Date(run.createdAt).toLocaleTimeString()} ·{" "}
                    {run.purpose ?? "implement"} · {run.status}
                  </span>
                  {run.filesTouched.length > 0 ? (
                    <span
                      className="shrink-0 text-[10px] text-ink-faint"
                      title={run.filesTouched.join("\n")}
                    >
                      {run.filesTouched.length} file{run.filesTouched.length > 1 ? "s" : ""}
                    </span>
                  ) : null}
                  <span className="text-[10px] text-ink-faint">{formatRunCost(run.costUsd)}</span>
                  <ExternalLink className="h-3 w-3 text-ink-faint" />
                </button>
              ))}
            </div>
          </Field>
        ) : null}
      </div>
    </aside>
  );
}

function QuestionRow({
  question,
  onAnswer,
}: {
  question: TaskQuestion;
  onAnswer: (question: TaskQuestion, answer: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const answered = question.answer != null;

  return (
    <div
      className={cn(
        "rounded-lg border px-2.5 py-2",
        answered ? "border-edge bg-surface-2 opacity-70" : "border-warn/30 bg-warn/5",
      )}
    >
      <div className="flex items-start gap-1.5 text-[11px] leading-snug text-ink">
        <CircleHelp className={cn("mt-0.5 h-3 w-3 shrink-0", answered ? "text-ink-faint" : "text-warn")} />
        <span className="whitespace-pre-wrap">{question.text}</span>
      </div>
      {answered ? (
        <div className="mt-1 pl-4.5 text-[11px] text-ink-muted">↳ {question.answer}</div>
      ) : (
        <div className="mt-1.5 flex items-end gap-1.5">
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={2}
            placeholder="Your answer…"
            className="text-[11px]"
            aria-label="Answer"
          />
          <Button
            variant="primary"
            size="sm"
            disabled={sending || !draft.trim()}
            onClick={() => {
              setSending(true);
              setError(null);
              void onAnswer(question, draft.trim())
                .catch((err: Error) => setError(err.message))
                .finally(() => setSending(false));
            }}
            aria-label="Send answer and resume the agent"
          >
            <Send className="h-3 w-3" />
          </Button>
        </div>
      )}
      {error ? <p className="mt-1 pl-4.5 text-[10px] text-danger">{error}</p> : null}
    </div>
  );
}

const EMPTY_ARCHITECTURES: never[] = [];

function NodeLinks({
  task,
  patchTask,
}: {
  task: TaskItem;
  patchTask: (patch: Partial<TaskItem>) => void;
}) {
  const architectures = useWorkspace((s) => s.info?.architectures ?? EMPTY_ARCHITECTURES);
  const allNodes = architectures.flatMap((a) => a.graph.nodes.map((n) => ({ ...n, graph: a.graph.name })));
  if (allNodes.length === 0) return null;

  return (
    <Field label="Architecture links">
      <div className="flex max-h-28 flex-wrap gap-1.5 overflow-y-auto">
        {allNodes.map((node) => {
          const linked = task.links.nodeIds.includes(node.id);
          return (
            <button
              key={node.id}
              type="button"
              title={`${node.graph} / ${node.label}`}
              onClick={() =>
                patchTask({
                  links: {
                    ...task.links,
                    nodeIds: linked
                      ? task.links.nodeIds.filter((id) => id !== node.id)
                      : [...task.links.nodeIds, node.id],
                  },
                })
              }
            >
              <Badge tone={linked ? "cyan" : "neutral"} className="cursor-pointer">
                {node.label}
              </Badge>
            </button>
          );
        })}
      </div>
    </Field>
  );
}

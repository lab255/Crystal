import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlignJustify,
  Ban,
  ChevronDown,
  ChevronRight,
  FileDiff as FileDiffIcon,
  GitBranch,
  RefreshCw,
  Rows3,
  Trash2,
} from "lucide-react";
import { usageTotalTokens, type AgentRun, type RunEvent } from "@crystal/core";
import {
  Badge,
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  Input,
  Spinner,
  StatusDot,
  Tooltip,
  cn,
} from "@crystal/ui";
import { chainOf } from "./chain.js";
import { ChainTurns } from "./chain-turns.js";
import { parseUnifiedDiff, type FileDiff } from "./diff.js";
import { InteractiveRunBanner } from "./interactive-banner.js";
import { MessageComposer, type ComposerSendResult } from "./message-composer.js";
import { useAgents, useCrystal } from "./provider.js";
import {
  RunTranscript,
  formatRunCost,
  formatRunDuration,
  formatRunTokens,
  type TranscriptDensity,
} from "./run-transcript.js";

/** The `agent.diff` payload the Changes region renders (worktreePath lives on the run). */
export interface RunSurfaceDiff {
  diff: string;
  stat: string;
}

/** Mirror of `agent.applyWorktree`'s result — what `onApplyBranch` resolves to. */
export type ApplyBranchOutcome =
  | { ok: true; branch: string; commit: string }
  | { ok: false; reason: string };

export interface RunSurfaceProps {
  run: AgentRun;
  events: readonly RunEvent[];
  /** The run's resume chain, oldest first (see `chainOf`). */
  chain: readonly AgentRun[];
  /** Latest worktree diff, or null when not (yet) loaded. */
  diff: RunSurfaceDiff | null;
  onRefreshDiff?: () => void | Promise<void>;
  onApplyBranch?: (branch: string) => Promise<ApplyBranchOutcome>;
  onDiscard?: () => void | Promise<void>;
  /** Routes the message (workflow/hub/plain — the adopter decides). Absent = no composer. */
  onSend?: (text: string) => Promise<ComposerSendResult | void>;
  onCancel?: () => void | Promise<void>;
  /** Turn selection routing (nav store, local state…). Absent = strip hidden. */
  onSelectTurn?: (runId: string) => void;
  className?: string;
}

/**
 * THE run surface: one composed view of a single agent run — header,
 * activity (transcript or PTY handoff), conversation (turn strip + composer)
 * and worktree changes. All data and verbs arrive via props so the
 * orchestrator, hub, workflow tab and the future attention queue can each
 * drive it with their own routing; `useRunSurface` wraps the agent-store
 * wiring for the common case.
 */
export function RunSurface({
  run,
  events,
  chain,
  diff,
  onRefreshDiff,
  onApplyBranch,
  onDiscard,
  onSend,
  onCancel,
  onSelectTurn,
  className,
}: RunSurfaceProps) {
  const [density, setDensity] = useState<TranscriptDensity>("comfortable");
  const live = run.status === "running" || run.status === "queued";
  const interactive = Boolean(run.terminalId);
  const tokens = usageTotalTokens(run.usage);

  return (
    <div className={cn("flex h-full min-h-0 flex-col", className)}>
      <header className="flex items-center gap-2.5 border-b border-edge px-3 py-2">
        <StatusDot status={run.status} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium text-ink">{run.prompt.split("\n")[0]}</div>
          <div className="mt-0.5 flex items-center gap-2 text-[10px] text-ink-faint">
            {run.purpose ? <Badge tone="violet">{run.purpose}</Badge> : null}
            {run.agentId ? <Badge tone="cyan">{run.agentId}</Badge> : null}
            {run.model ? <span>{run.model}</span> : null}
            <span>{formatRunCost(run.costUsd)}</span>
            {tokens > 0 ? <span>{formatRunTokens(tokens)} tok</span> : null}
            {run.turns != null ? <span>{run.turns} turns</span> : null}
            <span>{formatRunDuration(run.durationMs)}</span>
          </div>
        </div>
        {!interactive ? (
          <Tooltip
            content={
              density === "comfortable"
                ? "Compact transcript (one line per event)"
                : "Comfortable transcript (full event blocks)"
            }
          >
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Toggle transcript density"
              onClick={() => setDensity((d) => (d === "comfortable" ? "compact" : "comfortable"))}
            >
              {density === "comfortable" ? (
                <AlignJustify className="h-3 w-3" />
              ) : (
                <Rows3 className="h-3 w-3" />
              )}
            </Button>
          </Tooltip>
        ) : null}
        {live && onCancel ? (
          <Button variant="danger" size="xs" onClick={() => void onCancel()}>
            <Ban className="h-3 w-3" /> Cancel
          </Button>
        ) : null}
      </header>

      {/* Activity: the terminal owns an interactive run's transcript. */}
      {interactive ? (
        <>
          <InteractiveRunBanner run={run} className="border-b border-edge" />
          <div className="min-h-0 flex-1" />
        </>
      ) : (
        <RunTranscript
          events={events}
          runId={run.id}
          density={density}
          starting={run.status === "running"}
        />
      )}

      {/* Conversation: pick a turn, steer the session. */}
      {onSelectTurn && chain.length > 1 ? (
        <ChainTurns
          runs={chain}
          activeId={run.id}
          onSelect={onSelectTurn}
          className="border-t border-edge px-3 py-1.5"
        />
      ) : null}
      {onSend ? <MessageComposer onSend={onSend} className="border-t border-edge" /> : null}

      {run.worktreePath ? (
        <ChangesRegion
          run={run}
          diff={diff}
          onRefreshDiff={onRefreshDiff}
          onApplyBranch={onApplyBranch}
          onDiscard={onDiscard}
        />
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Changes region                                                      */
/* ------------------------------------------------------------------ */

/**
 * A syntactically valid git branch name, by the refname rules that matter in
 * practice. Returns the problem, or null when the name is acceptable.
 */
export function branchNameError(name: string): string | null {
  const n = name.trim();
  if (!n) return "Branch name is required.";
  if (/[\s~^:?*[\\\x00-\x1f]/.test(n)) {
    return "No spaces or ~ ^ : ? * [ \\ characters.";
  }
  if (n.includes("..") || n.includes("@{") || n.includes("//")) {
    return "Must not contain .. or @{ or //.";
  }
  if (n.startsWith("-") || n.startsWith("/") || n.startsWith(".")) {
    return "Must not start with - / or a dot.";
  }
  if (n.endsWith("/") || n.endsWith(".") || n.endsWith(".lock")) {
    return "Must not end with / . or .lock";
  }
  return null;
}

function ChangesRegion({
  run,
  diff,
  onRefreshDiff,
  onApplyBranch,
  onDiscard,
}: {
  run: AgentRun;
  diff: RunSurfaceDiff | null;
  onRefreshDiff?: () => void | Promise<void>;
  onApplyBranch?: (branch: string) => Promise<ApplyBranchOutcome>;
  onDiscard?: () => void | Promise<void>;
}) {
  const [refreshing, setRefreshing] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const [discarding, setDiscarding] = useState(false);

  const files = useMemo(() => (diff ? parseUnifiedDiff(diff.diff) : null), [diff]);

  const refresh = useCallback(async () => {
    if (!onRefreshDiff || refreshing) return;
    setRefreshing(true);
    try {
      await onRefreshDiff();
    } finally {
      setRefreshing(false);
    }
  }, [onRefreshDiff, refreshing]);

  // First render with a worktree and no diff yet: ask for one, once per run.
  const requestedFor = useRef<string | null>(null);
  useEffect(() => {
    if (diff !== null || requestedFor.current === run.id) return;
    requestedFor.current = run.id;
    void refresh();
  }, [diff, run.id, refresh]);

  const totals = useMemo(() => {
    if (!files) return null;
    let add = 0;
    let del = 0;
    for (const f of files) {
      add += f.additions;
      del += f.deletions;
    }
    return { add, del };
  }, [files]);

  return (
    <div className="flex max-h-[45%] shrink-0 flex-col border-t border-edge bg-surface-1">
      <div className="flex shrink-0 items-center gap-2 px-3 py-1.5">
        <GitBranch className="h-3.5 w-3.5 text-crystal-300" />
        <span className="text-xs font-medium text-ink">Changes</span>
        {files ? (
          <span className="text-[10px] text-ink-faint">
            {files.length} file{files.length === 1 ? "" : "s"}
            {totals && (totals.add || totals.del) ? (
              <>
                {" "}
                · <span className="text-ok">+{totals.add}</span>{" "}
                <span className="text-danger">−{totals.del}</span>
              </>
            ) : null}
          </span>
        ) : null}
        <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-ink-faint">
          {run.worktreePath}
        </span>
        {onRefreshDiff ? (
          <Tooltip content="Refresh diff">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Refresh diff"
              onClick={() => void refresh()}
            >
              <RefreshCw className={cn("h-3 w-3", refreshing && "animate-spin")} />
            </Button>
          </Tooltip>
        ) : null}
        {onApplyBranch ? (
          <ApplyBranchDialog
            run={run}
            onApplyBranch={onApplyBranch}
            onApplied={(outcome) => {
              setNote(
                outcome.ok
                  ? `Committed ${outcome.commit.slice(0, 10)} on ${outcome.branch} — merge or PR it from the repo.`
                  : outcome.reason,
              );
              if (outcome.ok) void refresh();
            }}
          />
        ) : null}
        {onDiscard ? (
          confirmingDiscard ? (
            <span className="flex items-center gap-1.5">
              <span className="text-[10px] text-danger">Discard the worktree and its changes?</span>
              <Button
                variant="danger"
                size="xs"
                disabled={discarding}
                onClick={() => {
                  setDiscarding(true);
                  void Promise.resolve(onDiscard())
                    .catch((err: Error) => setNote(err.message))
                    .finally(() => {
                      setDiscarding(false);
                      setConfirmingDiscard(false);
                    });
                }}
              >
                Discard
              </Button>
              <Button variant="ghost" size="xs" onClick={() => setConfirmingDiscard(false)}>
                Keep
              </Button>
            </span>
          ) : (
            <Tooltip content="Discard worktree and its changes">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Discard worktree"
                onClick={() => setConfirmingDiscard(true)}
              >
                <Trash2 className="h-3 w-3 text-danger" />
              </Button>
            </Tooltip>
          )
        ) : null}
      </div>
      {note ? <p className="shrink-0 px-3 pb-1.5 text-[10px] text-ink-muted">{note}</p> : null}
      <div className="min-h-0 overflow-y-auto border-t border-edge">
        {files === null ? (
          <div className="flex items-center gap-2 px-3 py-2 text-xs text-ink-faint">
            <Spinner className="h-3.5 w-3.5" /> Loading diff…
          </div>
        ) : files.length === 0 ? (
          <div className="px-3 py-2 text-xs text-ink-faint">No changes in the worktree yet.</div>
        ) : (
          files.map((f) => <FileDiffRow key={`${f.status}:${f.path}`} file={f} />)
        )}
      </div>
    </div>
  );
}

const STATUS_LETTERS: Record<FileDiff["status"], { letter: string; className: string }> = {
  added: { letter: "A", className: "text-ok" },
  modified: { letter: "M", className: "text-warn" },
  deleted: { letter: "D", className: "text-danger" },
  renamed: { letter: "R", className: "text-accent-cyan" },
};

/** One file of the worktree diff: header row, expandable colored hunks. */
function FileDiffRow({ file }: { file: FileDiff }) {
  const [open, setOpen] = useState(false);
  const status = STATUS_LETTERS[file.status];
  const expandable = file.hunks.length > 0;
  return (
    <div className="border-b border-edge/60 last:border-b-0">
      <button
        type="button"
        disabled={!expandable && !file.binary}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-1.5 px-2.5 py-1 text-left hover:bg-surface-2/60"
      >
        {expandable || file.binary ? (
          open ? (
            <ChevronDown className="h-3 w-3 shrink-0 text-ink-faint" />
          ) : (
            <ChevronRight className="h-3 w-3 shrink-0 text-ink-faint" />
          )
        ) : (
          <FileDiffIcon className="h-3 w-3 shrink-0 text-ink-faint" />
        )}
        <span className={cn("w-3 shrink-0 font-mono text-[10px] font-semibold", status.className)}>
          {status.letter}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink">
          {file.oldPath ? (
            <>
              <span className="text-ink-faint">{file.oldPath} → </span>
              {file.path}
            </>
          ) : (
            file.path
          )}
        </span>
        {file.binary ? (
          <span className="shrink-0 text-[10px] text-ink-faint">binary</span>
        ) : (
          <span className="shrink-0 font-mono text-[10px]">
            <span className="text-ok">+{file.additions}</span>{" "}
            <span className="text-danger">−{file.deletions}</span>
          </span>
        )}
      </button>
      {open ? (
        file.binary ? (
          <div className="border-t border-edge/60 px-3 py-1.5 text-[10px] text-ink-faint">
            Binary file — no textual diff.
          </div>
        ) : (
          <div className="overflow-x-auto border-t border-edge/60">
            {file.hunks.map((hunk, i) => (
              <pre key={i} className="font-mono text-[11px] leading-relaxed">
                <span className="block bg-surface-2 px-3 py-0.5 text-ink-faint">{hunk.header}</span>
                {hunk.lines.map((line, j) => (
                  <span
                    key={j}
                    className={cn(
                      "block whitespace-pre-wrap break-all px-3",
                      line.kind === "add"
                        ? "bg-ok/10 text-ok"
                        : line.kind === "del"
                          ? "bg-danger/10 text-danger"
                          : "text-ink-muted",
                    )}
                  >
                    {(line.kind === "add" ? "+" : line.kind === "del" ? "-" : " ") +
                      (line.text || " ")}
                  </span>
                ))}
              </pre>
            ))}
          </div>
        )
      ) : null}
    </div>
  );
}

/** "Apply as branch…" with a real dialog — branch name input and validation. */
function ApplyBranchDialog({
  run,
  onApplyBranch,
  onApplied,
}: {
  run: AgentRun;
  onApplyBranch: (branch: string) => Promise<ApplyBranchOutcome>;
  onApplied: (outcome: ApplyBranchOutcome) => void;
}) {
  const [open, setOpen] = useState(false);
  const [branch, setBranch] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const validation = branchNameError(branch);

  function openDialog(next: boolean): void {
    setOpen(next);
    if (next) {
      setBranch(run.branch ?? `crystal/${run.id}`);
      setError(null);
    }
  }

  async function apply(): Promise<void> {
    if (validation || busy) return;
    setBusy(true);
    setError(null);
    try {
      const outcome = await onApplyBranch(branch.trim());
      if (outcome.ok) {
        setOpen(false);
        onApplied(outcome);
      } else {
        setError(outcome.reason);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={openDialog}>
      <Tooltip content="Commit these changes onto a branch in the repo (worktrees share refs — merge or PR it from there)">
        <Button
          variant="secondary"
          size="xs"
          disabled={run.status === "running"}
          onClick={() => openDialog(true)}
        >
          <GitBranch className="h-3 w-3" /> Apply as branch…
        </Button>
      </Tooltip>
      <DialogContent
        title="Apply as branch"
        description="Commit the worktree's changes onto this branch — it is immediately mergeable from the repo."
      >
        <div className="space-y-2">
          <Input
            autoFocus
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void apply();
            }}
            placeholder="branch name"
            aria-label="Branch name"
            className="font-mono"
          />
          {branch && validation ? <p className="text-[11px] text-danger">{validation}</p> : null}
          {error ? <p className="text-[11px] text-danger">{error}</p> : null}
          <div className="flex justify-end gap-2 pt-1">
            <DialogClose asChild>
              <Button variant="ghost" size="sm">
                Cancel
              </Button>
            </DialogClose>
            <Button
              variant="primary"
              size="sm"
              disabled={busy || validation !== null}
              onClick={() => void apply()}
            >
              {busy ? <Spinner className="h-3 w-3" /> : <GitBranch className="h-3 w-3" />} Apply
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/* Store wiring for the common case                                    */
/* ------------------------------------------------------------------ */

const EMPTY_RUN_EVENTS: RunEvent[] = [];
const EMPTY_CHAIN: AgentRun[] = [];

/**
 * Agent-store wiring for RunSurface's common case: the run, its events
 * (hydrated on demand), its chain, the worktree diff, and the cancel /
 * refresh / apply / discard verbs against the active workspace's bridge.
 * Message routing (`onSend`) and turn selection stay with the adopter — a
 * workflow message is not a hub message is not a plain steer.
 */
export function useRunSurface(runId: string | null): {
  run: AgentRun | null;
  events: readonly RunEvent[];
  chain: readonly AgentRun[];
  diff: RunSurfaceDiff | null;
  onRefreshDiff: () => Promise<void>;
  onApplyBranch: (branch: string) => Promise<ApplyBranchOutcome>;
  onDiscard: () => Promise<void>;
  onCancel: () => Promise<void>;
} {
  const { client } = useCrystal();
  const runs = useAgents((s) => s.runs);
  const events = useAgents((s) => (runId ? (s.eventsByRun[runId] ?? EMPTY_RUN_EVENTS) : EMPTY_RUN_EVENTS));
  const loadEvents = useAgents((s) => s.loadEvents);
  const cancel = useAgents((s) => s.cancel);

  const run = useMemo(() => (runId ? (runs.find((r) => r.id === runId) ?? null) : null), [runs, runId]);
  const chain = useMemo(() => (run ? chainOf(runs, run) : EMPTY_CHAIN), [runs, run]);

  useEffect(() => {
    if (runId) void loadEvents(runId);
  }, [runId, loadEvents]);

  const [diff, setDiff] = useState<RunSurfaceDiff | null>(null);
  useEffect(() => setDiff(null), [runId]);

  const onRefreshDiff = useCallback(async () => {
    if (!runId) return;
    const result = await client.request("agent.diff", { runId });
    setDiff({ diff: result.diff, stat: result.stat });
  }, [client, runId]);

  const onApplyBranch = useCallback(
    async (branch: string): Promise<ApplyBranchOutcome> => {
      if (!runId) return { ok: false, reason: "No run selected." };
      return client.request("agent.applyWorktree", { runId, branch });
    },
    [client, runId],
  );

  const onDiscard = useCallback(async () => {
    if (!runId) return;
    await client.request("agent.cleanupWorktree", { runId });
    setDiff(null);
  }, [client, runId]);

  const onCancel = useCallback(async () => {
    if (runId) await cancel(runId);
  }, [cancel, runId]);

  return { run, events, chain, diff, onRefreshDiff, onApplyBranch, onDiscard, onCancel };
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlignJustify,
  Ban,
  ChevronDown,
  ChevronRight,
  FileDiff as FileDiffIcon,
  GitBranch,
  GitMerge,
  KeyRound,
  RefreshCw,
  Rows3,
  Sparkles,
  Timer,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import {
  formatResetsAt,
  runFailureHint,
  usageTotalTokens,
  type AgentProfile,
  type AgentRun,
  type MergePreviewResult,
  type MergeResult,
  type RunEvent,
} from "@crystal/core";

// zustand v5: selectors must return stable references.
const EMPTY_PROFILES: AgentProfile[] = [];
import {
  Badge,
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  Input,
  Select,
  Spinner,
  StatusDot,
  Tooltip,
  cn,
} from "@crystal/ui";
import { chainOf } from "./chain.js";
import { ChainTurns } from "./chain-turns.js";
import { parseUnifiedDiff, type FileDiff } from "./diff.js";
import { InteractiveRunBanner } from "./interactive-banner.js";
import { InteractiveRunTerminal } from "./run-terminal.js";
import { MessageComposer, type ComposerSendResult } from "./message-composer.js";
import { useAgents, useCrystal, useWorkspace } from "./provider.js";
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

/**
 * Merge-back controls for an isolated run's worktree (see worktree-merge.ts
 * server-side): the non-destructive prediction plus the land / resolve /
 * abort verbs. Wired by {@link useRunSurface}; absent = the Changes region
 * offers only apply-as-branch and discard.
 */
export interface MergeControls {
  preview: MergePreviewResult | null;
  onRefresh: () => Promise<void>;
  onMerge: () => Promise<MergeResult>;
  onResolve: () => Promise<{ run: AgentRun; conflicts: string[] }>;
  onAbort: () => Promise<void>;
}

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
  /** Worktree merge-back (prediction + land/resolve/abort). Absent = hidden. */
  merge?: MergeControls | null;
  /** Routes the message (workflow/hub/plain — the adopter decides). Absent = no composer. */
  onSend?: (text: string) => Promise<ComposerSendResult | void>;
  onCancel?: () => void | Promise<void>;
  /**
   * Close/dismiss the surface (the adopter decides what that means — the
   * coordinator ends the manager session, a picker just deselects). Absent =
   * no close button.
   */
  onClose?: () => void | Promise<void>;
  /** Tooltip for the close button (default "Close"). */
  closeHint?: string;
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
  merge,
  onSend,
  onCancel,
  onClose,
  closeHint,
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
        {onClose ? (
          <Tooltip content={closeHint ?? "Close"}>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={closeHint ?? "Close"}
              onClick={() => void onClose()}
            >
              <X className="h-3 w-3" />
            </Button>
          </Tooltip>
        ) : null}
      </header>

      {/* Activity: an interactive run's transcript is its PTY — embed it,
          shared live with the bottom panel's tab (same server terminal). */}
      {interactive ? (
        <>
          <InteractiveRunBanner run={run} className="border-b border-edge" />
          <InteractiveRunTerminal run={run} />
        </>
      ) : (
        <RunTranscript
          events={events}
          runId={run.id}
          density={density}
          starting={run.status === "running"}
        />
      )}

      {run.status === "failed" && run.failure ? <FailureBanner run={run} /> : null}

      {/* Conversation: pick a turn, steer the session. */}
      {onSelectTurn && chain.length > 1 ? (
        <ChainTurns
          runs={chain}
          activeId={run.id}
          onSelect={onSelectTurn}
          className="border-t border-edge px-3 py-1.5"
        />
      ) : null}
      {/* A live interactive run takes input in its PTY — a composer beside
          the terminal is a second, confusing input path. It returns once the
          terminal is gone (the chain then steers headlessly via deliver). */}
      {onSend && !(interactive && live) ? (
        <MessageComposer
          onSend={onSend}
          // Mid-turn sends queue server-side; say so up front instead of
          // surprising the user with the "queued" notice after the fact.
          placeholder={
            live
              ? "Queue a follow-up — it delivers when this turn settles (Ctrl+Enter)"
              : undefined
          }
          className="border-t border-edge"
        />
      ) : null}

      {run.worktreePath ? (
        <ChangesRegion
          run={run}
          diff={diff}
          onRefreshDiff={onRefreshDiff}
          onApplyBranch={onApplyBranch}
          onDiscard={onDiscard}
          merge={merge}
        />
      ) : null}
    </div>
  );
}

/**
 * Recoverable-failure banner: the classification (see run-failure.ts) plus
 * exactly one recovery affordance — handoff for context overflow, the reset
 * time for usage limits, the login hint for a broken CLI auth.
 */
function FailureBanner({ run }: { run: AgentRun }) {
  const { client } = useCrystal();
  // A handoff already recovered this run — point at it instead of re-offering.
  // Selector-level find: returns an existing run object (stable reference),
  // so unrelated stream events don't re-render the banner.
  const successor = useAgents((s) => s.runs.find((r) => r.handoffFromRunId === run.id) ?? null);
  const rosterAgents = useWorkspace((s) => s.roster?.agents ?? EMPTY_PROFILES);
  const [busy, setBusy] = useState(false);
  // "" = same profile (classic fresh-session handoff); an id = multi-agent
  // handoff — the continuation runs as that profile, vendor and all.
  const [targetId, setTargetId] = useState("");
  const failure = run.failure!;

  async function handoff(): Promise<void> {
    setBusy(true);
    try {
      await client.request("agent.handoff", {
        runId: run.id,
        targetAgentId: targetId || null,
      });
    } finally {
      setBusy(false);
    }
  }

  const Icon =
    failure.kind === "context_overflow" ? Sparkles : failure.kind === "usage_limit" ? Timer : KeyRound;
  return (
    <div className="shrink-0 border-t border-warn/30 bg-warn/8 px-3 py-2">
      <div className="flex items-start gap-2">
        <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warn" />
        <div className="min-w-0 flex-1 text-xs leading-relaxed text-ink">
          {runFailureHint(failure)}
          {failure.detail ? (
            <div className="mt-0.5 truncate font-mono text-[10px] text-ink-faint" title={failure.detail}>
              {failure.detail}
            </div>
          ) : null}
        </div>
        {failure.kind === "context_overflow" ? (
          successor ? (
            <Badge tone="cyan">handed off → {successor.id.slice(0, 10)}</Badge>
          ) : (
            <span className="flex shrink-0 items-center gap-1.5">
              {rosterAgents.length > 1 ? (
                <Select
                  size="sm"
                  value={targetId}
                  onChange={(e) => setTargetId(e.target.value)}
                  aria-label="Hand off to agent"
                  className="max-w-40"
                >
                  <option value="">Same agent</option>
                  {rosterAgents
                    .filter((a) => a.id !== run.agentId)
                    .map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                        {a.provider === "codex" ? " (codex)" : ""}
                      </option>
                    ))}
                </Select>
              ) : null}
              <Button variant="primary" size="xs" disabled={busy} onClick={() => void handoff()}>
                {busy ? <Spinner className="h-3 w-3" /> : <Sparkles className="h-3 w-3" />}
                Hand off
              </Button>
            </span>
          )
        ) : failure.kind === "usage_limit" && failure.resetsAt ? (
          <Badge tone="amber">resets {formatResetsAt(failure.resetsAt)}</Badge>
        ) : null}
      </div>
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
  merge,
}: {
  run: AgentRun;
  diff: RunSurfaceDiff | null;
  onRefreshDiff?: () => void | Promise<void>;
  onApplyBranch?: (branch: string) => Promise<ApplyBranchOutcome>;
  onDiscard?: () => void | Promise<void>;
  merge?: MergeControls | null;
}) {
  const [refreshing, setRefreshing] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [merging, setMerging] = useState<"merge" | "resolve" | "abort" | null>(null);
  const live = run.status === "running" || run.status === "queued";
  const preview = merge?.preview ?? null;
  const conflicted = (preview?.conflicts.length ?? 0) > 0;

  async function mergeAct(kind: "merge" | "resolve" | "abort"): Promise<void> {
    if (!merge) return;
    setMerging(kind);
    setNote(null);
    try {
      if (kind === "merge") {
        const result = await merge.onMerge();
        setNote(
          `Merged into ${result.target} as ${result.mergedCommit.slice(0, 10)}${result.fastForward ? " (fast-forward)" : ""}.`,
        );
      } else if (kind === "resolve") {
        const result = await merge.onResolve();
        setNote(
          `Resolution agent ${result.run.id.slice(0, 10)} started on ${result.conflicts.length} conflicted file${result.conflicts.length === 1 ? "" : "s"}.`,
        );
      } else {
        await merge.onAbort();
        setNote("Conflict resolution aborted — the worktree is back to its own work.");
      }
      await Promise.all([merge.onRefresh(), Promise.resolve(onRefreshDiff?.())]);
    } catch (err) {
      setNote((err as Error).message);
    } finally {
      setMerging(null);
    }
  }

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
        {preview?.target ? (
          <span className="flex shrink-0 items-center gap-1.5 text-[10px] text-ink-faint">
            <span>
              → <span className="font-mono text-ink-muted">{preview.target}</span>
            </span>
            {preview.ahead > 0 ? <span>{preview.ahead} ahead</span> : null}
            {preview.behind > 0 ? <span>{preview.behind} behind</span> : null}
            {preview.dirty ? <span>uncommitted</span> : null}
            {preview.resolving ? <Badge tone="amber">resolving conflicts</Badge> : null}
            {conflicted ? (
              <Tooltip content={preview.conflicts.join("\n")}>
                <Badge tone="rose">{preview.conflicts.length} conflicts</Badge>
              </Tooltip>
            ) : null}
          </span>
        ) : null}
        <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-ink-faint">
          {run.worktreePath}
        </span>
        {merge && !live && preview?.resolving ? (
          <Button
            variant="ghost"
            size="xs"
            disabled={merging !== null}
            onClick={() => void mergeAct("abort")}
          >
            {merging === "abort" ? <Spinner className="h-3 w-3" /> : <Ban className="h-3 w-3" />}
            Abort resolution
          </Button>
        ) : null}
        {merge && !live && conflicted && !preview?.resolving ? (
          <Tooltip content="Merge the target branch into this worktree with markers, and dispatch an agent to resolve and commit">
            <Button
              variant="ghost"
              size="xs"
              disabled={merging !== null}
              onClick={() => void mergeAct("resolve")}
            >
              {merging === "resolve" ? <Spinner className="h-3 w-3" /> : <Wrench className="h-3 w-3" />}
              Resolve with agent
            </Button>
          </Tooltip>
        ) : null}
        {merge && !live && preview?.canMerge ? (
          <Tooltip content={`Land this worktree on ${preview.target}`}>
            <Button
              variant="primary"
              size="xs"
              disabled={merging !== null}
              onClick={() => void mergeAct("merge")}
            >
              {merging === "merge" ? <Spinner className="h-3 w-3" /> : <GitMerge className="h-3 w-3" />}
              Merge
            </Button>
          </Tooltip>
        ) : null}
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
  merge: MergeControls;
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

  // Merge-back: the prediction loads eagerly once the run settles with a
  // worktree (the header controls hang off it); the verbs re-predict after.
  const [mergePreview, setMergePreview] = useState<MergePreviewResult | null>(null);
  useEffect(() => setMergePreview(null), [runId]);
  const refreshMerge = useCallback(async () => {
    if (!runId) return;
    await client
      .request("agent.mergePreview", { runId })
      .then(setMergePreview)
      .catch(() => setMergePreview(null));
  }, [client, runId]);
  const settledWithWorktree =
    run != null &&
    run.worktreePath != null &&
    run.status !== "running" &&
    run.status !== "queued";
  useEffect(() => {
    if (settledWithWorktree) void refreshMerge();
  }, [settledWithWorktree, refreshMerge]);

  // A run that just settled has just finished writing: refetch the diff on
  // the live→settled transition (same run only) so the Changes region shows
  // the final state without a manual refresh.
  const liveSeen = useRef<{ id: string | null; live: boolean }>({ id: null, live: false });
  useEffect(() => {
    const id = run?.id ?? null;
    const liveNow = run != null && (run.status === "running" || run.status === "queued");
    if (liveSeen.current.id === id && liveSeen.current.live && !liveNow && run?.worktreePath) {
      void onRefreshDiff();
    }
    liveSeen.current = { id, live: liveNow };
  }, [run, onRefreshDiff]);

  const merge = useMemo<MergeControls>(
    () => ({
      preview: mergePreview,
      onRefresh: refreshMerge,
      onMerge: () => {
        if (!runId) return Promise.reject(new Error("No run selected."));
        return client.request("agent.merge", { runId });
      },
      onResolve: () => {
        if (!runId) return Promise.reject(new Error("No run selected."));
        return client.request("agent.resolveConflicts", { runId });
      },
      onAbort: async () => {
        if (!runId) return;
        await client.request("agent.abortResolve", { runId });
      },
    }),
    [client, runId, mergePreview, refreshMerge],
  );

  return { run, events, chain, diff, onRefreshDiff, onApplyBranch, onDiscard, onCancel, merge };
}

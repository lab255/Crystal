import { useEffect, useMemo, useState } from "react";
import {
  Ban,
  Bot,
  Check,
  CircleDollarSign,
  Copy,
  MoreHorizontal,
  Pause,
  Play,
  Plus,
  RotateCcw,
  TerminalSquare,
  Trash2,
  X,
} from "lucide-react";
import {
  deliveryReadiness,
  isDeliveryTerminal,
  isProgramTerminal,
  type AgentRun,
  type Program,
  type ProgramDelivery,
  type ProgramSpend,
} from "@crystal/core";
import {
  EMPTY_HUB_EVENTS,
  RunSurface,
  chainOf,
  useHub,
  useNav,
  useNavUpdate,
  useTerminals,
  useWorkspaces,
} from "@crystal/client";
import {
  Button,
  EmptyState,
  Input,
  Select,
  Spinner,
  Textarea,
  Tooltip,
  useContextMenu,
  type MenuEntry,
} from "@crystal/ui";
import { parseBudget, SectionLabel, SpendLine, StatusBadge } from "./common.js";

/** Stable empty chain — a fresh [] per render would defeat the memo below. */
const EMPTY_TURNS: AgentRun[] = [];

/**
 * The Overview's coordinator chat — the program-manager session reduced to a
 * plain conversation. One program at a time (the header select switches;
 * `projects.program` deep-links one); the manager splits the goal across
 * projects, dispatches deliveries and sequences them over MCP, so talking to
 * it here IS driving the portfolio. Programs without a manager yet get the
 * start buttons; no programs at all gets the create form.
 */
export function CoordinatorChat() {
  const programs = useHub((s) => s.programs);
  const loaded = useHub((s) => s.loaded);
  const hubError = useHub((s) => s.error);
  const spend = useHub((s) => s.spend);
  const selectedId = useNav((l) => l.projects?.program) ?? null;
  const nav = useNavUpdate();
  const [creating, setCreating] = useState(false);
  const closeManager = useHub((s) => s.closeManager);
  const setPaused = useHub((s) => s.setPaused);
  const cancelProgram = useHub((s) => s.cancel);
  const removeProgram = useHub((s) => s.remove);
  const menu = useContextMenu();

  // Live programs first, newest first inside each half — the select's order.
  const ordered = useMemo(() => {
    const rank = (p: Program) => (isProgramTerminal(p.status) ? 1 : 0);
    return [...programs].sort(
      (a, b) => rank(a) - rank(b) || b.createdAt.localeCompare(a.createdAt),
    );
  }, [programs]);
  const program = ordered.find((p) => p.id === selectedId) ?? ordered[0] ?? null;

  if (!loaded) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <Spinner />
      </div>
    );
  }

  if (!program && hubError && !creating) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-6">
        <EmptyState icon={Bot} title="Coordinator unavailable">
          {hubError}
        </EmptyState>
      </div>
    );
  }

  if (creating || !program) {
    return (
      <CreateProgramPanel
        cancelable={program !== null}
        onCancel={() => setCreating(false)}
        onCreated={(id) => {
          setCreating(false);
          nav({ projects: { view: "chat", program: id, turn: null } });
        }}
      />
    );
  }

  const sp = spend[program.id] ?? null;
  const terminal = isProgramTerminal(program.status);

  // The one management surface for the selected program: reachable from the
  // "⋯" button and by right-clicking the header. Program cancel/remove had no
  // UI at all before this — they were store methods only.
  const programMenu = (p: Program): MenuEntry[] => [
    { type: "heading", label: p.name },
    { type: "item", label: "New program…", icon: Plus, onSelect: () => setCreating(true) },
    {
      type: "item",
      label: "Copy program id",
      icon: Copy,
      onSelect: () => void navigator.clipboard?.writeText(p.id),
    },
    { type: "separator" },
    {
      type: "item",
      label: "Close coordinator session",
      icon: X,
      disabled: !p.managerRunId,
      hint: p.managerRunId ? undefined : "none",
      onSelect: () => void closeManager(p.id),
    },
    ...(isProgramTerminal(p.status)
      ? []
      : [
          {
            type: "item" as const,
            label: p.status === "paused" ? "Resume program" : "Pause program",
            icon: p.status === "paused" ? Play : Pause,
            onSelect: () => void setPaused(p.id, p.status !== "paused"),
          },
        ]),
    { type: "separator" },
    isProgramTerminal(p.status)
      ? {
          type: "item",
          label: "Remove program",
          icon: Trash2,
          danger: true,
          onSelect: () => {
            const fallback = ordered.find((o) => o.id !== p.id);
            void removeProgram(p.id).then(() =>
              nav({ projects: { view: "chat", program: fallback?.id ?? null, turn: null } }),
            );
          },
        }
      : {
          type: "item",
          label: "Cancel program",
          icon: Ban,
          danger: true,
          onSelect: () => void cancelProgram(p.id),
        },
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {menu.element}
      <div
        className="flex shrink-0 items-center gap-2 border-b border-edge px-4 py-2"
        onContextMenu={(e) => menu.open(e, programMenu(program))}
      >
        <Bot className="h-4 w-4 shrink-0 text-crystal-300" />
        <Select
          size="xs"
          aria-label="Program"
          value={program.id}
          onChange={(e) =>
            nav({ projects: { view: "chat", program: e.target.value, turn: null } })
          }
          options={ordered.map((p) => ({ value: p.id, label: p.name }))}
          className="w-56"
        />
        <StatusBadge status={program.status} />
        <ProgramBudgetChip program={program} spend={sp} />
        <span className="min-w-0 flex-1 truncate text-[11px] text-ink-faint" title={program.goal}>
          {program.goal}
        </span>
        <Tooltip content="Start another program">
          <Button variant="ghost" size="icon-sm" aria-label="New program" onClick={() => setCreating(true)}>
            <Plus className="h-3.5 w-3.5" />
          </Button>
        </Tooltip>
        <Tooltip content="Manage this program">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Program menu"
            onClick={(e) => menu.open(e, programMenu(program))}
          >
            <MoreHorizontal className="h-3.5 w-3.5" />
          </Button>
        </Tooltip>
      </div>
      {hubError ? <p className="px-4 py-1 text-[11px] text-danger">{hubError}</p> : null}
      <DeliveryStrip program={program} programs={programs} spend={sp} />
      <ManagerPane program={program} />
    </div>
  );
}

function ProgramBudgetChip({
  program,
  spend,
}: {
  program: Program;
  spend: ProgramSpend | null;
}) {
  const setBudget = useHub((s) => s.setBudget);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setEditing(false);
    setError(null);
  }, [program.id]);

  async function save(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await setBudget(program.id, parseBudget(value));
      setEditing(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return editing ? (
    <form
      className="flex shrink-0 items-center gap-1"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <Input
        autoFocus
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder="(no budget — unbounded)"
        aria-label="Program budget in USD"
        className="h-6 w-44 text-[11px]"
      />
      <Button
        type="submit"
        variant="ghost"
        size="icon-sm"
        disabled={busy}
        aria-label="Set program budget"
      >
        {busy ? <Spinner className="h-3 w-3" /> : <Check className="h-3 w-3" />}
      </Button>
      {error ? (
        <span className="max-w-48 truncate text-[10px] text-danger" title={error}>
          {error}
        </span>
      ) : null}
    </form>
  ) : (
    <button
      type="button"
      onClick={() => {
        setValue(program.budgetUsd?.toString() ?? "");
        setError(null);
        setEditing(true);
      }}
      className="flex shrink-0 items-center gap-1 rounded-full border border-edge bg-surface-2 px-2 py-0.5 text-[11px] text-ink-muted hover:border-crystal-500/40 hover:text-ink"
      title="Edit program budget"
    >
      <CircleDollarSign className="h-3 w-3 text-crystal-300" />
      <SpendLine
        costUsd={spend?.costUsd ?? 0}
        budgetUsd={program.budgetUsd}
        stale={spend?.stale ?? false}
        showUnbudgeted
      />
    </button>
  );
}

function DeliveryStrip({
  program,
  programs,
  spend,
}: {
  program: Program;
  programs: Program[];
  spend: ProgramSpend | null;
}) {
  const others = useMemo(
    () => programs.filter((candidate) => candidate.id !== program.id),
    [program.id, programs],
  );
  return (
    <section className="shrink-0 border-b border-edge bg-surface-1/70 px-4 py-2">
      <div className="mb-1 flex items-center gap-2">
        <SectionLabel>Deliveries</SectionLabel>
        <span className="text-[10px] text-ink-faint">{program.deliveries.length}</span>
      </div>
      {program.deliveries.length === 0 ? (
        <p className="text-[11px] text-ink-faint">
          The coordinator has not split this program into projects yet.
        </p>
      ) : (
        <div className="flex gap-2 overflow-x-auto pb-0.5">
          {program.deliveries.map((delivery) => (
            <DeliveryCard
              key={delivery.id}
              program={program}
              delivery={delivery}
              others={others}
              spend={spend}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function DeliveryCard({
  program,
  delivery,
  others,
  spend,
}: {
  program: Program;
  delivery: ProgramDelivery;
  others: Program[];
  spend: ProgramSpend | null;
}) {
  const retryDelivery = useHub((s) => s.retryDelivery);
  const closeDelivery = useHub((s) => s.closeDelivery);
  const [closing, setClosing] = useState(false);
  const [outcome, setOutcome] = useState<"completed" | "failed">("completed");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const readiness =
    delivery.status === "pending" ? deliveryReadiness(program, delivery, others) : null;
  const blockedReason =
    delivery.status === "pending"
      ? readiness && !readiness.ready
        ? readiness.reason
        : delivery.note
      : null;
  const ownSpend = spend?.byDelivery[delivery.id];
  const retryable = isDeliveryTerminal(delivery.status) && delivery.status !== "completed";

  async function retry(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await retryDelivery(program.id, delivery.id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function close(): Promise<void> {
    if (!note.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await closeDelivery(program.id, delivery.id, outcome, note.trim());
      setClosing(false);
      setNote("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="min-w-72 max-w-96 rounded-lg border border-edge bg-surface-0 px-2.5 py-2">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-ink" title={delivery.projectRoot}>
          {delivery.projectName}
        </span>
        <StatusBadge status={delivery.status} />
        <span className="text-[10px] text-ink-faint">
          <SpendLine
            costUsd={ownSpend?.costUsd ?? 0}
            budgetUsd={delivery.budgetUsd}
            stale={spend?.stale ?? false}
          />
        </span>
      </div>
      {blockedReason ? (
        <p className="mt-1 line-clamp-2 text-[10px] leading-snug text-warn" title={blockedReason}>
          {blockedReason}
        </p>
      ) : null}
      {closing ? (
        <form
          className="mt-1.5 flex items-center gap-1"
          onSubmit={(event) => {
            event.preventDefault();
            void close();
          }}
        >
          <Select
            size="xs"
            value={outcome}
            onChange={(event) => setOutcome(event.target.value as "completed" | "failed")}
            aria-label="Delivery outcome"
          >
            <option value="completed">Completed</option>
            <option value="failed">Failed</option>
          </Select>
          <Input
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="What settled it?"
            aria-label="Delivery close note"
            className="h-6 min-w-32 flex-1 text-[10px]"
          />
          <Button type="submit" variant="primary" size="xs" disabled={busy || !note.trim()}>
            Close
          </Button>
          <Button type="button" variant="ghost" size="xs" onClick={() => setClosing(false)}>
            Cancel
          </Button>
        </form>
      ) : (
        <div className="mt-1.5 flex items-center justify-end gap-1">
          {retryable ? (
            <Button variant="ghost" size="xs" disabled={busy} onClick={() => void retry()}>
              <RotateCcw className="h-3 w-3" /> Retry
            </Button>
          ) : null}
          {!isDeliveryTerminal(delivery.status) ? (
            <Button variant="ghost" size="xs" disabled={busy} onClick={() => setClosing(true)}>
              Close
            </Button>
          ) : null}
        </div>
      )}
      {error ? <p className="mt-1 text-[10px] text-danger">{error}</p> : null}
    </article>
  );
}

/** Name + goal, nothing else — budgets and deliveries are the manager's job. */
function CreateProgramPanel({
  cancelable,
  onCancel,
  onCreated,
}: {
  cancelable: boolean;
  onCancel: () => void;
  onCreated: (programId: string) => void;
}) {
  const createProgram = useHub((s) => s.createProgram);
  const [name, setName] = useState("");
  const [goal, setGoal] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    if (!name.trim() || !goal.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const program = await createProgram({ name: name.trim(), goal: goal.trim() });
      onCreated(program.id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 items-start justify-center overflow-y-auto p-6">
      <div className="w-full max-w-xl space-y-3 rounded-xl border border-edge bg-surface-1/60 p-4">
        <SectionLabel>Start a program</SectionLabel>
        <p className="text-[11px] text-ink-muted">
          A program is one high-level goal the coordinating agent splits across your projects —
          dispatching each piece to that project's own orchestrator and sequencing them as
          dependencies land. Name it, state the goal, then talk to the coordinator.
        </p>
        <Input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Program name — e.g. Unified auth across the stack"
          aria-label="Program name"
        />
        <Textarea
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          rows={4}
          placeholder="The goal, in your own words — what done looks like, constraints, priorities…"
          aria-label="Program goal"
        />
        <div className="flex items-center gap-2">
          <Button variant="primary" size="sm" disabled={busy || !name.trim() || !goal.trim()} onClick={() => void create()}>
            Create program
          </Button>
          {cancelable ? (
            <Button variant="ghost" size="sm" onClick={onCancel}>
              Cancel
            </Button>
          ) : null}
        </div>
        {error ? <p className="text-[11px] text-danger">{error}</p> : null}
      </div>
    </div>
  );
}

/**
 * The manager session as a chat pane — the resume-chain transcript plus the
 * composer (`hub.message` under it). Same mechanics the hub's program detail
 * used; program and turn selection live in the nav store so copied links
 * reopen the same point in the conversation.
 */
function ManagerPane({ program }: { program: Program }) {
  const runs = useHub((s) => s.runs);
  const eventsByRun = useHub((s) => s.eventsByRun);
  const loadRunEvents = useHub((s) => s.loadRunEvents);
  const startManager = useHub((s) => s.startManager);
  const message = useHub((s) => s.message);
  const cancelRun = useHub((s) => s.cancelRun);
  const closeManager = useHub((s) => s.closeManager);
  const activeWs = useWorkspaces((s) => s.activeId);
  const openWsIds = useWorkspaces((s) => s.workspaces);
  const focusTerminal = useTerminals((s) => s.focusTerminal);
  const selectedRun = useNav((l) => l.projects?.turn) ?? null;
  const nav = useNavUpdate();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // Where an interactive manager's PTY would live: prefer a workspace this
  // program is already delivering into, else whatever is active.
  const hostWs =
    program.deliveries
      .map((d) => d.ws)
      .find((ws) => ws && openWsIds.some((w) => w.id === ws)) ?? activeWs;

  async function startInteractive(): Promise<void> {
    if (!hostWs) return;
    const run = await startManager(program.id, { ws: hostWs });
    if (run.terminalId) await focusTerminal(hostWs, run.terminalId);
  }

  // The manager's chain: every turn of the session, oldest first — the shared
  // resume-lineage walk anchored on the run the program record points at.
  const chain = useMemo(() => {
    const anchor = runs.find((r) => r.id === program.managerRunId);
    return anchor ? chainOf(runs, anchor) : EMPTY_TURNS;
  }, [runs, program.managerRunId]);
  const latest = chain[chain.length - 1] ?? null;
  const viewed = chain.find((r) => r.id === selectedRun) ?? latest;
  const events = viewed ? (eventsByRun[viewed.id] ?? EMPTY_HUB_EVENTS) : EMPTY_HUB_EVENTS;

  // Keyed on the id: `viewed` is a fresh object on every run event, and
  // depending on it re-fires this request on every usage tick.
  const viewedId = viewed?.id ?? null;
  useEffect(() => {
    if (viewedId) void loadRunEvents(viewedId);
  }, [viewedId, loadRunEvents]);

  const terminal = isProgramTerminal(program.status);

  if (!program.managerRunId) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-4 py-4">
        <EmptyState
          icon={Bot}
          title="No coordinator session yet"
          action={
            terminal ? undefined : (
              <div className="flex items-center gap-2">
                <Tooltip content="A native interactive Claude session in the terminal panel — it asks you decisions directly; notices and answers are typed into it live.">
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={busy || !hostWs}
                    onClick={() => {
                      setBusy(true);
                      void startInteractive()
                        .catch((err: Error) => setNotice(err.message))
                        .finally(() => setBusy(false));
                    }}
                  >
                    <TerminalSquare className="h-3 w-3" /> Start in terminal
                  </Button>
                </Tooltip>
                <Tooltip content="A headless session driven from this chat — it wakes on settlements and questions, and you steer it with messages here.">
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy}
                    onClick={() => {
                      setBusy(true);
                      void startManager(program.id)
                        .catch((err: Error) => setNotice(err.message))
                        .finally(() => setBusy(false));
                    }}
                  >
                    <Bot className="h-3 w-3" /> Start headless
                  </Button>
                </Tooltip>
              </div>
            )
          }
        >
          The coordinator owns this program: it splits the goal across projects, dispatches each
          delivery to that project's orchestrator, and sequences them as dependencies land.
          {notice ? ` ${notice}` : ""}
        </EmptyState>
      </div>
    );
  }

  return viewed ? (
    <RunSurface
      run={viewed}
      events={events}
      chain={chain}
      diff={null}
      onCancel={() => cancelRun(viewed.id)}
      onClose={() => closeManager(program.id)}
      closeHint="Close the coordinator session — cancels any live turn; the start buttons return"
      onSend={terminal ? undefined : (t) => message(program.id, t)}
      onSelectTurn={(id) =>
        nav({
          projects: {
            view: "chat",
            program: program.id,
            turn: id === latest?.id ? null : id,
          },
        })
      }
      className="min-h-0 flex-1"
    />
  ) : null;
}

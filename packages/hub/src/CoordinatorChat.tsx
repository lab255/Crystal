import { useEffect, useMemo, useState } from "react";
import { Bot, Plus, TerminalSquare } from "lucide-react";
import { isProgramTerminal, type AgentRun, type Program } from "@crystal/core";
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
} from "@crystal/ui";
import { SectionLabel, SpendLine, StatusBadge } from "./common.js";

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

  if (creating || !program) {
    return (
      <CreateProgramPanel
        cancelable={program !== null}
        onCancel={() => setCreating(false)}
        onCreated={(id) => {
          setCreating(false);
          nav({ projects: { view: "chat", program: id } });
        }}
      />
    );
  }

  const sp = spend[program.id] ?? null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-edge px-4 py-2">
        <Bot className="h-4 w-4 shrink-0 text-crystal-300" />
        <Select
          size="xs"
          aria-label="Program"
          value={program.id}
          onChange={(e) => nav({ projects: { view: "chat", program: e.target.value } })}
          options={ordered.map((p) => ({ value: p.id, label: p.name }))}
          className="w-56"
        />
        <StatusBadge status={program.status} />
        {sp ? (
          <span className="text-[11px] text-ink-faint">
            <SpendLine costUsd={sp.costUsd} budgetUsd={program.budgetUsd} />
          </span>
        ) : null}
        <span className="min-w-0 flex-1 truncate text-[11px] text-ink-faint" title={program.goal}>
          {program.goal}
        </span>
        <Tooltip content="Start another program">
          <Button variant="ghost" size="icon-sm" aria-label="New program" onClick={() => setCreating(true)}>
            <Plus className="h-3.5 w-3.5" />
          </Button>
        </Tooltip>
      </div>
      {hubError ? <p className="px-4 py-1 text-[11px] text-danger">{hubError}</p> : null}
      <ManagerPane program={program} />
    </div>
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
 * used; turn selection is view-local here, the chat deep-links by program only.
 */
function ManagerPane({ program }: { program: Program }) {
  const runs = useHub((s) => s.runs);
  const eventsByRun = useHub((s) => s.eventsByRun);
  const loadRunEvents = useHub((s) => s.loadRunEvents);
  const startManager = useHub((s) => s.startManager);
  const message = useHub((s) => s.message);
  const cancelRun = useHub((s) => s.cancelRun);
  const activeWs = useWorkspaces((s) => s.activeId);
  const openWsIds = useWorkspaces((s) => s.workspaces);
  const focusTerminal = useTerminals((s) => s.focusTerminal);
  const [selectedRun, setSelectedRun] = useState<string | null>(null);
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
      onSend={terminal ? undefined : (t) => message(program.id, t)}
      onSelectTurn={(id) => setSelectedRun(id === latest?.id ? null : id)}
      className="min-h-0 flex-1"
    />
  ) : null;
}

import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  ChevronRight,
  MoreHorizontal,
  Plus,
  Route,
  Trash2,
  X,
} from "lucide-react";
import type { ArchitectureGraph, CodeTrace, Journey, SymbolSearchHit } from "@crystal/core";
import { uid } from "@crystal/core";
import { useCrystal } from "@crystal/client";
import {
  Badge,
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Input,
  Spinner,
  Tooltip,
  cn,
} from "@crystal/ui";
import type { FlowProjection } from "./dataflow.js";
import { SymbolSnippet } from "./snippets.js";

/** Prefill for the journey dialog ("Start journey here…" from the code map). */
export interface JourneySeed {
  file: string;
  symbol: string;
}

/* ------------------------------------------------------------------ */
/* Symbol search combobox                                               */
/* ------------------------------------------------------------------ */

function SymbolCombobox({
  value,
  onPick,
}: {
  value: JourneySeed | null;
  onPick: (hit: JourneySeed | null) => void;
}) {
  const { client } = useCrystal();
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SymbolSearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    clearTimeout(timer.current);
    const q = query.trim();
    if (q.length < 2) {
      setHits([]);
      return;
    }
    timer.current = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await client.request("codemap.symbols", { query: q, limit: 20 });
        setHits(res.symbols);
        setOpen(true);
      } catch {
        setHits([]);
      } finally {
        setSearching(false);
      }
    }, 200);
    return () => clearTimeout(timer.current);
  }, [client, query]);

  if (value) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-edge bg-surface-1 px-2 py-1.5 text-xs">
        <Route className="h-3.5 w-3.5 shrink-0 text-crystal-300" />
        <span className="min-w-0 flex-1 truncate font-mono text-ink">
          {value.symbol}
          <span className="text-ink-faint"> · {value.file}</span>
        </span>
        <button
          type="button"
          onClick={() => onPick(null)}
          className="shrink-0 text-ink-faint hover:text-ink"
          aria-label="Clear entry point"
        >
          <X className="h-3 w-3" />
        </button>
      </div>
    );
  }

  return (
    <div className="relative">
      <Input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onFocus={() => hits.length > 0 && setOpen(true)}
        placeholder="Search a function… e.g. createOrder"
        aria-label="Entry point symbol"
      />
      {searching ? <Spinner className="absolute right-2 top-2 h-3.5 w-3.5" /> : null}
      {open && hits.length > 0 ? (
        <div className="absolute z-30 mt-1 max-h-56 w-full overflow-y-auto rounded-lg border border-edge bg-surface-2 shadow-xl shadow-black/40">
          {hits.map((hit) => (
            <button
              key={`${hit.file}#${hit.name}`}
              type="button"
              onClick={() => {
                onPick({ file: hit.file, symbol: hit.name });
                setOpen(false);
                setQuery("");
              }}
              className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-[11.5px] hover:bg-surface-3"
            >
              <span className="min-w-0 flex-1 truncate font-mono text-ink">{hit.name}</span>
              {!hit.exported ? <Badge tone="neutral">int</Badge> : null}
              <span className="max-w-40 shrink-0 truncate text-[9.5px] text-ink-faint">{hit.file}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Sidebar section: journey list + create dialog                        */
/* ------------------------------------------------------------------ */

export function JourneysSection({
  graph,
  activeJourneyId,
  onActivate,
  onGraphChange,
  seed,
  onSeedConsumed,
}: {
  graph: ArchitectureGraph;
  activeJourneyId: string | null;
  onActivate: (id: string | null) => void;
  onGraphChange: (graph: ArchitectureGraph) => void;
  /** When set, the create dialog opens prefilled with this entry point. */
  seed: JourneySeed | null;
  onSeedConsumed: () => void;
}) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [name, setName] = useState("");
  const [entry, setEntry] = useState<JourneySeed | null>(null);

  useEffect(() => {
    if (seed) {
      setEntry(seed);
      setName(seed.symbol);
      setDialogOpen(true);
      onSeedConsumed();
    }
  }, [seed, onSeedConsumed]);

  const create = () => {
    if (!name.trim() || !entry) return;
    const journey: Journey = { id: uid("journey"), name: name.trim(), description: "", entry };
    onGraphChange({ ...graph, journeys: [...graph.journeys, journey] });
    onActivate(journey.id);
    setDialogOpen(false);
    setName("");
    setEntry(null);
  };

  return (
    <>
      <div className="mt-3 flex items-center justify-between px-1.5 pb-1">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
          Journeys
        </span>
        <Tooltip content="New user journey — pick a code entry point, see its dataflow">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setDialogOpen(true)}
            aria-label="New journey"
          >
            <Plus className="h-3.5 w-3.5" />
          </Button>
        </Tooltip>
      </div>
      {graph.journeys.map((j) => (
        <div
          key={j.id}
          className={cn(
            "group flex items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] cursor-pointer",
            activeJourneyId === j.id
              ? "bg-crystal-500/15 text-ink"
              : "text-ink-muted hover:bg-surface-2 hover:text-ink",
          )}
          onClick={() => onActivate(activeJourneyId === j.id ? null : j.id)}
        >
          <Route className="h-3.5 w-3.5 shrink-0 text-crystal-300/80" />
          <span className="min-w-0 flex-1 truncate">{j.name}</span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100"
                onClick={(e) => e.stopPropagation()}
                aria-label="Journey actions"
              >
                <MoreHorizontal className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem
                className="text-danger"
                onSelect={() => {
                  if (activeJourneyId === j.id) onActivate(null);
                  onGraphChange({ ...graph, journeys: graph.journeys.filter((x) => x.id !== j.id) });
                }}
              >
                <Trash2 className="h-3.5 w-3.5" /> Delete journey
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ))}
      {graph.journeys.length === 0 ? (
        <div className="px-2 py-1 text-[11px] text-ink-faint">
          Trace creation, update or submission flows from a code entry point.
        </div>
      ) : null}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent
          title="New journey"
          description="The dataflow is traced live from this entry point's call graph."
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              create();
            }}
            className="space-y-3"
          >
            <Input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Order submission"
              aria-label="Journey name"
            />
            <SymbolCombobox value={entry} onPick={setEntry} />
            <div className="flex justify-end gap-2">
              <DialogClose asChild>
                <Button variant="ghost" size="sm">
                  Cancel
                </Button>
              </DialogClose>
              <Button type="submit" variant="primary" size="sm" disabled={!name.trim() || !entry}>
                Create
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Right panel: trace steps with snippets                               */
/* ------------------------------------------------------------------ */

export function FlowStepsPanel({
  journey,
  trace,
  flow,
  error,
  onClose,
}: {
  journey: Journey;
  trace: CodeTrace | null;
  flow: FlowProjection | null;
  error: string | null;
  onClose: () => void;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const partial = trace ? trace.truncated || trace.unresolvedCalls.length > 0 : false;
  const unmapped = new Set(flow?.unmappedSteps.map((s) => `${s.ref.file}#${s.ref.symbol}`));

  return (
    <aside className="flex w-80 shrink-0 flex-col border-l border-edge bg-surface-1">
      <div className="border-b border-edge px-3 py-2.5">
        <div className="flex items-center gap-2">
          <Route className="h-3.5 w-3.5 shrink-0 text-crystal-300" />
          <span className="min-w-0 flex-1 truncate text-xs font-semibold text-ink">{journey.name}</span>
          <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close journey">
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
        <div className="mt-0.5 truncate font-mono text-[10px] text-ink-faint">
          {journey.entry.symbol} · {journey.entry.file}
        </div>
      </div>
      {partial ? (
        <div className="flex items-start gap-1.5 border-b border-warn/20 bg-warn/10 px-3 py-1.5 text-[10px] text-warn">
          <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
          <span>
            Trace is partial — dynamic and instance-method calls are not followed
            {trace?.truncated ? "; depth/size cap reached" : ""}.
          </span>
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {error ? <div className="text-[11px] text-warn">{error}</div> : null}
        {!trace && !error ? (
          <div className="flex items-center gap-2 text-[11px] text-ink-faint">
            <Spinner className="h-3 w-3" /> tracing…
          </div>
        ) : null}
        {trace?.steps.map((step) => {
          const key = `${step.ref.file}#${step.ref.symbol}`;
          return (
            <div key={key} style={{ paddingLeft: Math.min(step.depth, 6) * 10 }}>
              <button
                type="button"
                onClick={() => setExpanded(expanded === key ? null : key)}
                className="flex w-full items-center gap-1.5 rounded-md px-1 py-0.5 text-left text-[11.5px] hover:bg-surface-2"
              >
                <ChevronRight
                  className={cn(
                    "h-3 w-3 shrink-0 text-ink-faint transition-transform",
                    expanded === key && "rotate-90",
                  )}
                />
                <span className="min-w-0 flex-1 truncate font-mono text-ink">{step.ref.symbol}</span>
                {unmapped.has(key) ? (
                  <Tooltip content="This module is not linked to any diagram node">
                    <Badge tone="amber">unmapped</Badge>
                  </Tooltip>
                ) : null}
                <span className="max-w-32 shrink-0 truncate text-[9px] text-ink-faint">
                  {step.module}
                </span>
              </button>
              {expanded === key ? (
                <SymbolSnippet file={step.ref.file} symbol={step.ref.symbol} className="mb-1.5 ml-4 mt-1" />
              ) : null}
            </div>
          );
        })}
        {trace && trace.steps.length <= 1 ? (
          <div className="mt-2 text-[11px] text-ink-faint">
            No further calls resolved from the entry point.
          </div>
        ) : null}
      </div>
    </aside>
  );
}

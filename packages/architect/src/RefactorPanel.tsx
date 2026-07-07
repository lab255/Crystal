import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  Bot,
  ChevronRight,
  Loader2,
  PackagePlus,
  Wand2,
  Wrench,
  X,
} from "lucide-react";
import {
  validateRefactorIntents,
  type CodeSymbol,
  type RefactorIntent,
  type RefactorIntentProblem,
  type RefactorPlan,
} from "@crystal/core";
import { useCrystal } from "@crystal/client";
import {
  Badge,
  Button,
  CodeSnippet,
  Dialog,
  DialogClose,
  DialogContent,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
  Tooltip,
  cn,
} from "@crystal/ui";

/** Human-readable one-liner for an intent. */
export function intentLabel(intent: RefactorIntent): string {
  if (intent.kind === "move") {
    return `move ${intent.symbol}: ${intent.fromFile} → ${intent.toFile ?? intent.toModule}`;
  }
  if (intent.kind === "moveFile") {
    return `move file ${intent.fromFile} → ${intent.toFile ?? intent.toModule}`;
  }
  const name = intent.newName ?? intent.symbols[0]!.symbol;
  return `hoist ${name} (${intent.symbols.length}×) → ${intent.targetModule}`;
}

/**
 * Validate intents against the live code map (symbols may have been renamed
 * or deleted upstream since they were recorded). Re-checks on codemap.changed.
 */
export function useIntentProblems(intents: RefactorIntent[]): RefactorIntentProblem[] {
  const { client } = useCrystal();
  const [problems, setProblems] = useState<RefactorIntentProblem[]>([]);
  const [generation, setGeneration] = useState(0);

  useEffect(() => client.events.on("codemap.changed", () => setGeneration((g) => g + 1)), [client]);

  useEffect(() => {
    if (intents.length === 0) {
      setProblems([]);
      return;
    }
    const files = new Set<string>();
    for (const intent of intents) {
      if (intent.kind === "move" || intent.kind === "moveFile") files.add(intent.fromFile);
      else for (const s of intent.symbols) files.add(s.file);
    }
    let cancelled = false;
    Promise.all(
      [...files].map(async (file) => {
        try {
          const detail = await client.request("codemap.file", { path: file });
          return [file, detail.symbols ?? detail.exports] as const;
        } catch {
          return [file, null] as const;
        }
      }),
    ).then((entries) => {
      if (cancelled) return;
      const index = new Map<string, CodeSymbol[] | null>(entries);
      setProblems(validateRefactorIntents(intents, (file) => index.get(file) ?? null));
    });
    return () => {
      cancelled = true;
    };
  }, [client, intents, generation]);

  return problems;
}

/** DraftBar chip: pending refactor count with a review/remove dropdown. */
export function RefactorChip({
  intents,
  problems,
  onRemove,
}: {
  intents: RefactorIntent[];
  problems: RefactorIntentProblem[];
  onRemove: (id: string) => void;
}) {
  if (intents.length === 0) return null;
  const stale = new Set(problems.map((p) => p.intent.id));
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            "flex items-center gap-1 rounded-lg px-1.5 py-0.5 text-[11px] font-medium",
            stale.size > 0 ? "bg-danger/15 text-danger" : "bg-warn/15 text-warn",
          )}
        >
          <Wand2 className="h-3 w-3" />
          {intents.length} refactor{intents.length > 1 ? "s" : ""}
          {stale.size > 0 ? <AlertTriangle className="h-3 w-3" /> : null}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="center" className="w-96">
        <div className="max-h-72 overflow-y-auto p-1">
          {intents.map((intent) => {
            const problem = problems.find((p) => p.intent.id === intent.id);
            return (
              <div key={intent.id} className="flex items-start gap-2 rounded-md px-2 py-1.5 text-[11px] hover:bg-surface-3">
                {intent.kind === "hoist" ? (
                  <PackagePlus className="mt-0.5 h-3 w-3 shrink-0 text-warn" />
                ) : (
                  <ArrowRight className="mt-0.5 h-3 w-3 shrink-0 text-warn" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-ink">{intentLabel(intent)}</div>
                  {problem ? (
                    <div className="mt-0.5 flex items-center gap-1 text-[10px] text-danger">
                      <AlertTriangle className="h-2.5 w-2.5 shrink-0" />
                      {problem.problem}
                    </div>
                  ) : null}
                </div>
                <button
                  type="button"
                  onClick={() => onRemove(intent.id)}
                  className="shrink-0 rounded p-0.5 text-ink-faint hover:text-danger"
                  aria-label="Remove refactor"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            );
          })}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Confirmation shown when applying a draft that carries refactor intents:
 * moves preview through the engine, hoists are queued as agent-owned tasks on
 * the project board (dispatched from there, not at apply time).
 */
export function ApplyRefactorsDialog({
  open,
  onOpenChange,
  intents,
  onConfirm,
  busy,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  intents: RefactorIntent[];
  onConfirm: () => void;
  busy: boolean;
}) {
  const { client } = useCrystal();
  const [plans, setPlans] = useState<RefactorPlan[] | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const hoists = useMemo(() => intents.filter((i) => i.kind === "hoist"), [intents]);

  useEffect(() => {
    if (!open) {
      setPlans(null);
      setPreviewError(null);
      setExpanded(null);
      return;
    }
    let cancelled = false;
    client
      .request("refactor.preview", { intents })
      .then((res) => !cancelled && setPlans(res.plans))
      .catch((err: Error) => !cancelled && setPreviewError(err.message));
    return () => {
      cancelled = true;
    };
  }, [open, client, intents]);

  const engineBadge = (engine: RefactorPlan["engine"]) =>
    engine === "language-service" ? (
      <Badge tone="emerald">
        <Wrench className="h-2.5 w-2.5" /> ts refactor
      </Badge>
    ) : engine === "manual" ? (
      <Badge tone="amber">
        <Wrench className="h-2.5 w-2.5" /> textual + shim
      </Badge>
    ) : (
      <Badge tone="violet">
        <Bot className="h-2.5 w-2.5" /> board task
      </Badge>
    );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Apply draft with refactors"
        description="The diagram changes apply first; then moves run through the refactor engine and hoists are queued on the project board, assigned to an agent for dispatch."
      >
        <div className="max-h-[50vh] space-y-2 overflow-y-auto">
          {previewError ? <div className="text-[11px] text-warn">{previewError}</div> : null}
          {!plans && !previewError ? (
            <div className="flex items-center gap-2 py-2 text-[11px] text-ink-faint">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> planning changes…
            </div>
          ) : null}
          {plans?.map((plan) => {
            const intent = intents.find((i) => i.id === plan.intentId);
            if (!intent) return null;
            return (
              <div key={plan.intentId} className="rounded-lg border border-edge bg-surface-1 p-2">
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink">
                    {intentLabel(intent)}
                  </span>
                  {engineBadge(plan.engine)}
                </div>
                {plan.warnings.map((w, i) => (
                  <div key={i} className="mt-1 flex items-start gap-1 text-[10px] text-warn">
                    <AlertTriangle className="mt-px h-2.5 w-2.5 shrink-0" /> {w}
                  </div>
                ))}
                <div className="mt-1 space-y-0.5">
                  {plan.changes.map((change, i) => {
                    const key = `${plan.intentId}:${i}`;
                    return (
                      <div key={key}>
                        <button
                          type="button"
                          onClick={() => setExpanded(expanded === key ? null : key)}
                          disabled={!change.preview}
                          className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-[10.5px] text-ink-muted hover:bg-surface-2 disabled:cursor-default"
                        >
                          {change.preview ? (
                            <ChevronRight
                              className={cn("h-2.5 w-2.5 shrink-0 transition-transform", expanded === key && "rotate-90")}
                            />
                          ) : (
                            <span className="w-2.5 shrink-0" />
                          )}
                          <span className="min-w-0 flex-1 truncate font-mono">{change.file}</span>
                          <span className="shrink-0 text-ink-faint">{change.summary}</span>
                        </button>
                        {expanded === key && change.preview ? (
                          <CodeSnippet code={change.preview} className="my-1 ml-4 max-h-48" />
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
        {hoists.length > 0 ? (
          <div className="mt-2 text-[11px] text-ink-muted">
            {hoists.length} hoist{hoists.length > 1 ? "s" : ""} will be queued on the project
            board as agent-owned task{hoists.length > 1 ? "s" : ""} under an epic named after
            this draft.
          </div>
        ) : null}
        <div className="mt-3 flex justify-end gap-2">
          <DialogClose asChild>
            <Button variant="ghost" size="sm" disabled={busy}>
              Cancel
            </Button>
          </DialogClose>
          <Tooltip content="Apply the diagram, execute moves, queue hoist tasks on the board, close the draft">
            <Button variant="primary" size="sm" disabled={busy || !plans} onClick={onConfirm}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              Apply everything
            </Button>
          </Tooltip>
        </div>
      </DialogContent>
    </Dialog>
  );
}

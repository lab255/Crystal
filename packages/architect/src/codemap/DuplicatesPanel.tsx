import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, Copy, PackagePlus, X } from "lucide-react";
import {
  createHoistIntent,
  type CodeModule,
  type DuplicateCluster,
  type DuplicateInstance,
  type HoistIntent,
} from "@crystal/core";
import { useCrystal } from "@crystal/client";
import {
  Badge,
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  EmptyState,
  Input,
  Select,
  Spinner,
  cn,
} from "@crystal/ui";
import { SymbolSnippet } from "../snippets.js";

/**
 * Duplicate-function clusters (identical normalized token streams) with a
 * two-up source compare and a "hoist to shared package" action that records
 * a hoist intent on the active draft plan (creating one when none is open).
 */
export function DuplicatesPanel({
  ws,
  moduleFilter,
  modules,
  hasActiveDraft,
  onHoist,
  onClose,
}: {
  ws?: string;
  /** Only clusters with an instance inside this module (module level). */
  moduleFilter?: string;
  /** Workspace modules — hoist-target suggestions. */
  modules: CodeModule[];
  hasActiveDraft: boolean;
  /** Record the intent (parent appends to the draft, creating one if needed). */
  onHoist: (intent: HoistIntent) => void;
  onClose: () => void;
}) {
  const { client } = useCrystal();
  const [clusters, setClusters] = useState<DuplicateCluster[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [compare, setCompare] = useState<[DuplicateInstance, DuplicateInstance] | null>(null);
  const [hoisting, setHoisting] = useState<DuplicateCluster | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    const fetchClusters = () => {
      client
        .request("codemap.duplicates", { ws })
        .then((res) => !cancelled && (setClusters(res.clusters), setError(null)))
        .catch((err: Error) => !cancelled && setError(err.message));
    };
    fetchClusters();
    const dispose = client.events.on("codemap.changed", () => {
      clearTimeout(timer.current);
      timer.current = setTimeout(fetchClusters, 500);
    });
    return () => {
      cancelled = true;
      clearTimeout(timer.current);
      dispose();
    };
  }, [client, ws]);

  const shown = useMemo(() => {
    if (!clusters) return null;
    if (!moduleFilter) return clusters;
    return clusters.filter((c) => c.instances.some((i) => i.module === moduleFilter));
  }, [clusters, moduleFilter]);

  return (
    <aside className="flex h-full w-full flex-col bg-surface-1">
      <div className="flex items-center gap-2 border-b border-edge px-3 py-2.5">
        <Copy className="h-3.5 w-3.5 shrink-0 text-crystal-300" />
        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-ink">
          Duplicated functions
          {moduleFilter ? <span className="text-ink-faint"> in {moduleFilter}</span> : null}
        </span>
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close duplicates">
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {error ? <div className="text-[11px] text-warn">{error}</div> : null}
        {!shown && !error ? (
          <div className="flex items-center gap-2 text-[11px] text-ink-faint">
            <Spinner className="h-3 w-3" /> scanning for clones…
          </div>
        ) : null}
        {shown?.map((cluster) => {
          const primary = cluster.instances[0]!;
          const moduleSet = [...new Set(cluster.instances.map((i) => i.module))];
          return (
            <div key={cluster.hash} className="mb-2 rounded-lg border border-edge bg-surface-2 p-2">
              <button
                type="button"
                onClick={() => setExpanded(expanded === cluster.hash ? null : cluster.hash)}
                className="flex w-full items-center gap-1.5 text-left"
              >
                <ChevronRight
                  className={cn("h-3 w-3 shrink-0 text-ink-faint transition-transform", expanded === cluster.hash && "rotate-90")}
                />
                <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-ink">
                  {primary.symbol}
                </span>
                <Badge tone="amber">{cluster.instances.length}×</Badge>
                <span className="shrink-0 text-[9px] text-ink-faint">{cluster.tokenCount} tokens</span>
              </button>
              <div className="mt-1 flex flex-wrap gap-1 pl-4">
                {moduleSet.map((m) => (
                  <Badge key={m} tone="neutral">
                    {m}
                  </Badge>
                ))}
              </div>
              {expanded === cluster.hash ? (
                <div className="mt-1.5 space-y-1 pl-4">
                  {cluster.instances.map((inst) => (
                    <div key={`${inst.file}#${inst.symbol}`} className="flex items-center gap-1.5 text-[10.5px]">
                      <span className="min-w-0 flex-1 truncate font-mono text-ink-muted">
                        {inst.file}
                        <span className="text-ink-faint">:{inst.line}</span>
                      </span>
                      {!inst.exported ? <Badge tone="neutral">int</Badge> : null}
                    </div>
                  ))}
                  <div className="flex gap-1.5 pt-1">
                    {cluster.instances.length >= 2 ? (
                      <Button
                        variant="secondary"
                        size="xs"
                        onClick={() => setCompare([cluster.instances[0]!, cluster.instances[1]!])}
                      >
                        Compare
                      </Button>
                    ) : null}
                    <Button variant="primary" size="xs" onClick={() => setHoisting(cluster)}>
                      <PackagePlus className="h-3 w-3" /> Hoist to shared package…
                    </Button>
                  </div>
                </div>
              ) : null}
            </div>
          );
        })}
        {shown && shown.length === 0 ? (
          <EmptyState icon={Copy} title="No duplicate functions">
            Nothing with an identical token stream (≥ 25 tokens) — or the clones
            differ by more than whitespace and comments.
          </EmptyState>
        ) : null}
      </div>

      {compare ? (
        <Dialog open onOpenChange={(open) => !open && setCompare(null)}>
          <DialogContent
            title="Compare duplicates"
            description="Identical token streams — differences are whitespace and comments only."
            className="w-[56rem] max-w-[92vw]"
          >
            <div className="grid grid-cols-2 gap-2">
              {compare.map((inst, i) => (
                <div key={i} className="min-w-0">
                  <div className="mb-1 truncate font-mono text-[10.5px] text-ink-muted">
                    {inst.file} · {inst.symbol}
                  </div>
                  <SymbolSnippet file={inst.file} symbol={inst.symbol} ws={ws} className="max-h-80" />
                </div>
              ))}
            </div>
          </DialogContent>
        </Dialog>
      ) : null}

      {hoisting ? (
        <HoistDialog
          cluster={hoisting}
          modules={modules}
          hasActiveDraft={hasActiveDraft}
          onConfirm={(intent) => {
            setHoisting(null);
            onHoist(intent);
          }}
          onClose={() => setHoisting(null)}
        />
      ) : null}
    </aside>
  );
}

function HoistDialog({
  cluster,
  modules,
  hasActiveDraft,
  onConfirm,
  onClose,
}: {
  cluster: DuplicateCluster;
  modules: CodeModule[];
  hasActiveDraft: boolean;
  onConfirm: (intent: HoistIntent) => void;
  onClose: () => void;
}) {
  const suggestions = useMemo(
    () => modules.filter((m) => m.path.startsWith("packages/")),
    [modules],
  );
  const [target, setTarget] = useState(suggestions[0]?.path ?? "packages/shared");
  const [custom, setCustom] = useState(false);
  const [newName, setNewName] = useState(cluster.instances[0]!.symbol);

  const confirm = () => {
    if (!target.trim()) return;
    onConfirm(
      createHoistIntent(
        cluster.instances.map((i) => ({ file: i.file, symbol: i.symbol })),
        target.trim(),
        newName.trim() || null,
      ),
    );
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        title="Hoist duplicates to a shared package"
        description={`${cluster.instances.length} identical implementations consolidate into one exported function. An agent run performs the edit when the draft plan is applied.`}
      >
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            confirm();
          }}
        >
          <label className="block">
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
              Target package
            </div>
            {custom || suggestions.length === 0 ? (
              <Input
                autoFocus
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                placeholder="packages/shared (created if missing)"
              />
            ) : (
              <Select
                value={target}
                onChange={(e) => {
                  if (e.target.value === "__custom__") {
                    setCustom(true);
                    setTarget("");
                  } else setTarget(e.target.value);
                }}
              >
                {suggestions.map((m) => (
                  <option key={m.path} value={m.path}>
                    {m.name} ({m.path})
                  </option>
                ))}
                <option value="__custom__">New package…</option>
              </Select>
            )}
          </label>
          <label className="block">
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
              Canonical name
            </div>
            <Input value={newName} onChange={(e) => setNewName(e.target.value)} />
          </label>
          {!hasActiveDraft ? (
            <div className="rounded-lg border border-warn/30 bg-warn/10 px-2 py-1.5 text-[10.5px] text-warn">
              No draft plan is open — confirming creates one carrying this hoist.
            </div>
          ) : null}
          <div className="flex justify-end gap-2">
            <DialogClose asChild>
              <Button variant="ghost" size="sm">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" variant="primary" size="sm" disabled={!target.trim()}>
              {hasActiveDraft ? "Add to draft" : "Create draft with hoist"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

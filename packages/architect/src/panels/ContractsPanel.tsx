import { ArrowRight, X } from "lucide-react";
import type { SystemOverview } from "@crystal/core";
import { Button, EmptyState, Tooltip } from "@crystal/ui";
import { ContractInspector, linkKeyOf } from "../systems/ContractInspector.js";

/**
 * Contracts on the architecture view: every system boundary, traffic-sorted,
 * drilling into the shared `ContractInspector` (declaration sources, import
 * and call sites, ←/→ traffic walks). Ported from the systems overview — the
 * inspector itself is reused unchanged; this panel supplies the list chrome
 * and maps selection onto the unified canvas.
 *
 * Selection is keyed by the overview's RAW link key ("sys:a->sys:b", the
 * `edge` deep-link param) — the caller converts to canonical canvas ids when
 * focusing nodes.
 */
export function ContractsPanel({
  overview,
  activeEdgeKey,
  onSelectEdge,
  onFocusSystem,
  onClose,
}: {
  overview: SystemOverview;
  /** Raw link key ("source->target"), or null for the boundary list. */
  activeEdgeKey: string | null;
  onSelectEdge: (key: string | null) => void;
  /** Focus a system's node on the canvas (raw overview id). */
  onFocusSystem: (rawId: string) => void;
  onClose: () => void;
}) {
  const byId = new Map(overview.systems.map((s) => [s.id, s]));
  const nameOf = (id: string): string => byId.get(id)?.name ?? id;
  // Traffic-sorted, dangling endpoints dropped — same universe the systems
  // overview showed, so the inspector's prev/next walks are identical.
  const links = overview.links
    .filter((l) => byId.has(l.source) && byId.has(l.target))
    .sort((a, b) => b.weight - a.weight);

  const active = activeEdgeKey ? links.find((l) => linkKeyOf(l) === activeEdgeKey) : null;
  if (active) {
    return (
      <ContractInspector
        link={active}
        links={links}
        systems={overview.systems}
        nameOf={nameOf}
        onSelectEdge={onSelectEdge}
        onSelectSystem={onFocusSystem}
        onClose={() => onSelectEdge(null)}
      />
    );
  }

  return (
    <div className="flex h-full flex-col bg-surface-1">
      <div className="flex items-center justify-between border-b border-edge px-3 py-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
          Contracts — {links.length} boundar{links.length === 1 ? "y" : "ies"}
        </span>
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close contracts">
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {links.length === 0 ? (
          <EmptyState title="No boundaries yet">
            Contracts appear once systems import from each other.
          </EmptyState>
        ) : (
          links.map((l) => (
            <Tooltip
              key={linkKeyOf(l)}
              content={
                l.symbols.length > 0
                  ? `Crossing symbols: ${l.symbols.slice(0, 6).join(", ")}${l.symbols.length > 6 ? "…" : ""}`
                  : "API-only boundary"
              }
            >
              <button
                type="button"
                onClick={() => onSelectEdge(linkKeyOf(l))}
                className="flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-[12px] text-ink-muted hover:bg-surface-2 hover:text-ink"
              >
                <span className="min-w-0 flex-1 truncate">
                  {nameOf(l.source)}
                  <ArrowRight className="mx-1 inline h-3 w-3 text-ink-faint" />
                  {nameOf(l.target)}
                </span>
                {(l.apis?.length ?? 0) > 0 ? (
                  <span className="shrink-0 rounded-full bg-crystal-500/15 px-1.5 text-[9px] leading-4 text-crystal-300">
                    {l.apis!.length} api
                  </span>
                ) : null}
                <span className="shrink-0 rounded-full bg-surface-3 px-1.5 text-[9px] leading-4 text-ink-faint">
                  {l.weight || "api"}
                </span>
              </button>
            </Tooltip>
          ))
        )}
      </div>
    </div>
  );
}

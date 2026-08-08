import { useMemo } from "react";
import { ChevronRight, Info } from "lucide-react";
import {
  C4_LEVELS,
  C4_LEVEL_LABELS,
  type C4Level,
  type C4Model,
  type C4View,
} from "@crystal/core";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Tooltip,
  cn,
} from "@crystal/ui";
import { ACCENT_CSS, EDGE_KIND_STYLE, KIND_META } from "./model.js";

/**
 * The C4 altitude control: a level ladder (System Context → Containers →
 * Components) with the scoped container as a breadcrumb picker at the
 * components level, plus the notation legend C4 asks every diagram to carry.
 * Level 4 (Code) is not a projection — it lives on the canvas itself
 * (zoom/double-click into any component) and as the codebase view.
 */
export function C4Bar({
  view,
  model,
  onNavigate,
}: {
  view: C4View;
  model: C4Model;
  onNavigate: (view: C4View) => void;
}) {
  const scoped = view.level === "components"
    ? model.containers.find((c) => c.id === view.scope)
    : undefined;

  return (
    <div className="flex items-center gap-1 rounded-xl border border-edge bg-surface-2/95 p-1 shadow-xl shadow-black/30 backdrop-blur">
      {C4_LEVELS.map((level, i) => (
        <span key={level} className="flex items-center gap-1">
          {i > 0 ? <ChevronRight className="h-3 w-3 text-ink-faint" /> : null}
          {level === "components" ? (
            <ComponentsCrumb
              active={view.level === "components"}
              scoped={scoped?.name ?? null}
              model={model}
              onPick={(scope) => onNavigate({ level: "components", scope })}
            />
          ) : (
            <button
              type="button"
              onClick={() => onNavigate({ level })}
              aria-pressed={view.level === level}
              className={cn(
                "rounded-lg px-2 py-1 text-[11px] font-medium transition-colors",
                view.level === level
                  ? "bg-surface-3 text-ink"
                  : "text-ink-muted hover:text-ink",
              )}
            >
              {C4_LEVEL_LABELS[level]}
            </button>
          )}
        </span>
      ))}
      <div className="mx-0.5 h-4 w-px bg-edge" />
      <Tooltip side="bottom" content={<C4Legend level={view.level} />}>
        <span className="flex h-6 w-6 cursor-help items-center justify-center rounded-lg text-ink-faint hover:text-ink">
          <Info className="h-3.5 w-3.5" />
        </span>
      </Tooltip>
    </div>
  );
}

function ComponentsCrumb({
  active,
  scoped,
  model,
  onPick,
}: {
  active: boolean;
  scoped: string | null;
  model: C4Model;
  onPick: (scope: string) => void;
}) {
  const containers = model.containers;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-pressed={active}
          className={cn(
            "flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-medium transition-colors",
            active ? "bg-surface-3 text-ink" : "text-ink-muted hover:text-ink",
          )}
        >
          {active && scoped ? (
            <>
              {C4_LEVEL_LABELS.components}
              <span className="max-w-40 truncate text-ink-faint">· {scoped}</span>
            </>
          ) : (
            C4_LEVEL_LABELS.components
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {containers.map((c) => (
          <DropdownMenuItem key={c.id} onSelect={() => onPick(c.id)}>
            <span
              className="h-2 w-2 shrink-0 rounded-sm"
              style={{ background: ACCENT_CSS[KIND_META.container.defaultAccent] }}
            />
            <span className="min-w-0 flex-1 truncate">{c.name}</span>
            <span className="text-[10px] text-ink-faint">
              {c.memberSystemIds.length}
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The per-level element vocabulary — C4's "every diagram needs a key". */
function C4Legend({ level }: { level: C4Level }) {
  const entries = useMemo(() => {
    const kind = (k: keyof typeof KIND_META, label: string) => ({
      label,
      color: ACCENT_CSS[KIND_META[k].defaultAccent],
    });
    if (level === "context") {
      return [
        kind("person", "Person — a user of the system"),
        kind("system", "The software system (double-click to enter)"),
        kind("external", "External system — SaaS the code calls"),
      ];
    }
    if (level === "containers") {
      return [
        kind("person", "Person"),
        kind("container", "Container — separately runnable unit"),
        kind("datastore", "Infrastructure container (database, queue…)"),
        kind("external", "External system"),
      ];
    }
    return [
      kind("service", "Component — a building block inside this container"),
      kind("entity", "Entity — a workspace data schema"),
      kind("container", "Neighbouring container"),
      kind("external", "External system / infrastructure"),
    ];
  }, [level]);
  return (
    <div className="flex max-w-64 flex-col gap-1.5 py-0.5">
      {entries.map((e) => (
        <span key={e.label} className="flex items-center gap-2 text-[11px]">
          <span className="h-2.5 w-2.5 shrink-0 rounded-sm border border-edge" style={{ background: e.color }} />
          {e.label}
        </span>
      ))}
      <div className="mt-1 border-t border-edge pt-1.5">
        {(["sync", "async", "data", "dependency"] as const).map((k) => (
          <span key={k} className="flex items-center gap-2 text-[11px]">
            <span
              className="h-0 w-4 shrink-0 border-t-2"
              style={{
                borderColor: EDGE_KIND_STYLE[k].stroke,
                borderStyle: EDGE_KIND_STYLE[k].dash ? "dashed" : "solid",
              }}
            />
            {EDGE_KIND_STYLE[k].label}
          </span>
        ))}
      </div>
    </div>
  );
}

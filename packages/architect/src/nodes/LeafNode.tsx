import { Handle, Position, type NodeProps } from "@xyflow/react";
import { memo } from "react";
import { Component, FolderGit2 } from "lucide-react";
import { Badge, cn } from "@crystal/ui";
import { ACCENT_CSS, KIND_META, accentOf, type ArchRfNode } from "../model.js";
import { highlightAttrs } from "../use-highlight.js";
import { DiffCornerBadge, diffBorderStyle, diffNodeClass } from "./diff-badge.js";
import { ROLE_META } from "../systems/role-meta.js";
import type { SystemCardFacts } from "../system-card.js";

/**
 * The semantic body of a system card (from the retired systems view): the
 * consumed export surface with consumer counts, and a Consumes footer naming
 * the systems · externals · libraries this one leans on. Rendered inside the
 * reserved slot at slot-scaled type, at the LOD tier where file chips are not
 * yet legible — once chips take over, the interior belongs to the code.
 */
function SystemCardBody({ facts, rowPx }: { facts: SystemCardFacts; rowPx: number }) {
  const headingPx = Math.max(8, Math.round(rowPx * 0.8));
  const rowH = Math.round(rowPx * 1.7);
  const hasConsumes =
    facts.consumes.length > 0 || facts.externals.length > 0 || facts.libraries.length > 0;
  return (
    <>
      {facts.exports.length > 0 ? (
        <div className="min-h-0 overflow-hidden border-t border-edge/60 pt-1">
          <div
            className="font-medium uppercase tracking-wide text-ink-faint"
            style={{ fontSize: headingPx }}
          >
            Exports
          </div>
          {facts.exports.map((e) => (
            <div key={e.name} className="flex items-baseline gap-1.5" style={{ lineHeight: `${rowH}px` }}>
              {e.component ? (
                <Component
                  className="shrink-0 self-center text-accent-violet"
                  style={{ width: rowPx, height: rowPx }}
                />
              ) : null}
              <span className="min-w-0 truncate font-mono text-ink-muted" style={{ fontSize: rowPx }}>
                {e.name}
              </span>
              <span className="ml-auto shrink-0 text-ink-faint" style={{ fontSize: headingPx }}>
                ×{e.consumers}
              </span>
            </div>
          ))}
          {facts.exportsMore > 0 ? (
            <div className="text-ink-faint" style={{ fontSize: headingPx, lineHeight: `${rowH}px` }}>
              +{facts.exportsMore} more
            </div>
          ) : null}
        </div>
      ) : null}
      {hasConsumes ? (
        <div className="mt-auto shrink-0 border-t border-edge/60 pt-1">
          <div
            className="font-medium uppercase tracking-wide text-ink-faint"
            style={{ fontSize: headingPx }}
          >
            Consumes
          </div>
          <div
            className="line-clamp-2 text-ink-muted"
            style={{ fontSize: rowPx, lineHeight: `${rowH}px` }}
          >
            {facts.consumes.slice(0, 3).join(", ")}
            {facts.consumes.length > 3 || facts.consumesMore > 0
              ? ` +${facts.consumes.length - 3 + facts.consumesMore}`
              : ""}
            {facts.externals.length > 0 ? (
              <span className="text-accent-amber">
                {facts.consumes.length > 0 ? " · " : ""}
                {facts.externals.slice(0, 2).join(", ")}
                {facts.externals.length > 2 || facts.externalsMore > 0
                  ? ` +${facts.externals.length - 2 + facts.externalsMore}`
                  : ""}
              </span>
            ) : null}
            {facts.libraries.length > 0 ? (
              <span className="text-ink-faint">
                {facts.consumes.length > 0 || facts.externals.length > 0 ? " · " : ""}
                {facts.libraries.slice(0, 2).join(", ")}
                {facts.libraries.length > 2 || facts.librariesMore > 0
                  ? ` +${facts.libraries.length - 2 + facts.librariesMore}`
                  : ""}
              </span>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
}

export const LeafNode = memo(function LeafNode({ data, selected }: NodeProps<ArchRfNode>) {
  const arch = data.arch;
  const meta = KIND_META[arch.kind];
  const facts = data.system;
  const roleMeta = facts ? ROLE_META[facts.role] : null;
  // Role accent/icon from the overview mark system cards; an explicit
  // user-picked accent still wins (it is overlay data, not a derivation).
  const accent = arch.accent ? ACCENT_CSS[arch.accent] : (roleMeta?.accent ?? accentOf(arch));
  const Icon = roleMeta?.icon ?? meta.icon;
  // The C4 projection's element type reads "[Container · Web application]",
  // C4-notation style; outside the C4 view the kind/role label stands.
  const kindLabel = data.c4Type ? `[${data.c4Type}]` : (roleMeta?.label ?? meta.label);
  const person = arch.kind === "person";
  const entity = arch.kind === "entity";
  const entityFields = arch.entityFields ?? [];
  const slot = data.slot;
  const component = data.c4Component;

  const hlAttrs = highlightAttrs(
    data.hlRef ?? {
      node: arch.id,
      module: arch.codeModule ?? undefined,
      file: arch.codeFile ?? undefined,
    },
  );

  const flowBadge =
    data.flow != null && data.flow.step !== null ? (
      <span
        className="absolute -left-2 -top-2 z-10 flex h-5 min-w-5 items-center justify-center rounded-full bg-crystal-500 px-1 font-mono text-[10px] font-bold text-white shadow-md"
        title={data.flow.step === 0 ? "Journey entry" : `Reached at hop ${data.flow.step}`}
      >
        {data.flow.step === 0 ? "▶" : data.flow.step}
      </span>
    ) : null;

  // Slotted (system-card) nodes fill their card slot: the box already has
  // the size the semantic body needs, so the body never clips or overlaps.
  if (slot) {
    const labelPx = Math.round(Math.min(24, Math.max(15, slot.width / 16)));
    const subPx = Math.round(Math.max(10, labelPx * 0.55));
    return (
      <div
        {...hlAttrs}
        className={cn(
          "relative flex h-full w-full flex-col rounded-xl border bg-surface-2/95 shadow-md shadow-black/30 transition-shadow",
          selected ? "border-crystal-400 shadow-lg shadow-crystal-500/20" : "border-edge-strong",
          data.flow?.step === null && "opacity-30",
          diffNodeClass(data.diff),
        )}
        style={{
          borderLeftWidth: 3,
          borderLeftColor: accent,
          ...(selected ? {} : diffBorderStyle(data.diff)),
        }}
      >
        {data.diff ? <DiffCornerBadge mark={data.diff} /> : null}
        {flowBadge}
        <Handle type="target" position={Position.Top} className="!h-2 !w-2 !border-none !bg-edge-strong" />
        {/* Identity, size, and the semantic body (exports × consumers,
            consumes footer) — what the component *is*, not its file soup.
            Live code is a double-click away. */}
        <div
          className={cn(
            "flex min-h-0 flex-1 flex-col gap-1.5 px-4 py-2.5",
            facts ? "overflow-hidden" : "justify-center",
          )}
        >
          <div className="flex min-w-0 items-center gap-2">
            <Icon style={{ color: accent, width: labelPx * 0.8, height: labelPx * 0.8 }} className="shrink-0" />
            <span className="min-w-0 truncate font-semibold leading-tight text-ink" style={{ fontSize: labelPx }}>
              {arch.label}
            </span>
          </div>
          <div
            className={cn("text-ink-faint", !data.c4Type && "uppercase tracking-wider")}
            style={{ fontSize: subPx * 0.85 }}
          >
            {kindLabel}
            {facts ? (
              <span className="normal-case tracking-normal">
                {" "}
                · {facts.fileCount} file{facts.fileCount === 1 ? "" : "s"}
                {facts.componentCount > 0
                  ? ` · ${facts.componentCount} component${facts.componentCount === 1 ? "" : "s"}`
                  : ""}
                {facts.endpointCount > 0
                  ? ` · ${facts.endpointCount} route${facts.endpointCount === 1 ? "" : "s"}`
                  : ""}
              </span>
            ) : data.code ? (
              <span className="normal-case tracking-normal"> · {data.code.fileCount} files</span>
            ) : null}
          </div>
          {arch.description ? (
            <div className="line-clamp-2 max-w-full shrink-0 leading-snug text-ink-muted" style={{ fontSize: subPx }}>
              {arch.description}
            </div>
          ) : null}
          {component?.interfaceNames.length ? (
            <div className="flex min-w-0 flex-wrap gap-1 border-t border-edge/60 pt-1.5">
              {component.interfaceNames.slice(0, 3).map((name) => (
                <span key={name} className="max-w-28 truncate rounded bg-surface-3 px-1.5 py-0.5 font-mono text-[9px] text-ink-muted">{name}</span>
              ))}
              {component.interfaceNames.length > 3 ? (
                <span className="px-1 py-0.5 font-mono text-[9px] text-ink-faint">+{component.interfaceNames.length - 3}</span>
              ) : null}
            </div>
          ) : null}
          {facts ? (
            <SystemCardBody facts={facts} rowPx={Math.max(9, Math.round(subPx * 0.95))} />
          ) : null}
          {!facts && arch.tech.length > 0 ? (
            <div className="mt-0.5 flex flex-wrap gap-1">
              {arch.tech.slice(0, 4).map((t) => (
                <Badge key={t} tone="neutral">
                  {t}
                </Badge>
              ))}
              {arch.tech.length > 4 ? <Badge tone="neutral">+{arch.tech.length - 4}</Badge> : null}
            </div>
          ) : null}
          {component && (component.fileCount > 0 || component.screenCount > 0 || component.routeCount > 0 || component.entityCount > 0) ? (
            <div className="mt-auto border-t border-edge/60 pt-1 text-[9px] text-ink-faint">
              {[
                component.fileCount ? `${component.fileCount} files` : "",
                component.screenCount ? `${component.screenCount} screens` : "",
                component.routeCount ? `${component.routeCount} routes` : "",
                component.entityCount ? `${component.entityCount} entities` : "",
              ].filter(Boolean).join(" · ")}
            </div>
          ) : null}
        </div>
        {data.code ? (
          <div
            className={cn(
              "mx-2 mb-2 flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[9.5px]",
              data.code.auto
                ? "border-dashed border-crystal-400/40 text-crystal-300/80"
                : "border-crystal-400/40 bg-crystal-500/10 text-crystal-300",
            )}
            title={data.code.auto ? "Suggested by name match — not saved yet" : "Linked code module"}
          >
            <FolderGit2 className="h-2.5 w-2.5 shrink-0" />
            <span className="truncate font-mono">{data.code.module}</span>
          </div>
        ) : null}
        <Handle type="source" position={Position.Bottom} className="!h-2 !w-2 !border-none !bg-edge-strong" />
      </div>
    );
  }

  return (
    <div
      {...hlAttrs}
      className={cn(
        "relative border bg-surface-2/95 px-3 py-2 shadow-md shadow-black/30",
        // C4 container/system cards read at the conventional generous width;
        // plain leaves stay compact.
        arch.kind === "container" || arch.kind === "system"
          ? "min-w-56 max-w-72"
          : entity
            ? "h-[90px] w-[180px] overflow-hidden"
            : "min-w-40 max-w-56",
        "transition-shadow",
        // The C4 person silhouette: a rounded head-and-shoulders card.
        person ? "rounded-t-[26px] rounded-b-lg" : "rounded-lg",
        selected ? "border-crystal-400 shadow-lg shadow-crystal-500/20" : "border-edge-strong",
        data.flow?.step === null && "opacity-30",
        diffNodeClass(data.diff),
      )}
      style={{
        ...(person ? {} : { borderLeftWidth: 3, borderLeftColor: accent }),
        ...(selected ? {} : diffBorderStyle(data.diff)),
      }}
    >
      {data.diff ? <DiffCornerBadge mark={data.diff} /> : null}
      {flowBadge}
      <Handle type="target" position={Position.Top} className="!h-2 !w-2 !border-none !bg-edge-strong" />
      {person ? (
        <div className="flex flex-col items-center gap-0.5 pt-1">
          <span
            className="flex h-8 w-8 items-center justify-center rounded-full"
            style={{ background: `color-mix(in srgb, ${accent} 18%, transparent)` }}
          >
            <Icon className="h-4.5 w-4.5" style={{ color: accent }} />
          </span>
          <div className="max-w-full truncate text-xs font-semibold text-ink">{arch.label}</div>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <Icon className="h-3.5 w-3.5 shrink-0" style={{ color: accent }} />
          <div className="truncate text-xs font-semibold text-ink">{arch.label}</div>
        </div>
      )}
      <div
        className={cn(
          "mt-0.5 text-[10px] text-ink-faint",
          !data.c4Type && "uppercase tracking-wider",
          person && "text-center",
        )}
      >
        {kindLabel}
      </div>
      {entity && entityFields.length > 0 ? (
        <div className="mt-1 grid grid-cols-2 gap-x-2 border-t border-edge/60 pt-1 font-mono text-[9px] leading-3 text-ink-muted">
          {entityFields.slice(0, 4).map((field) => (
            <span key={field} className="truncate" title={field}>
              {field}
            </span>
          ))}
          {entityFields.length > 4 ? (
            <span className="col-span-2 text-ink-faint">+{entityFields.length - 4} more</span>
          ) : null}
        </div>
      ) : null}
      {!entity && arch.description ? (
        <div
          className={cn(
            "mt-1 line-clamp-2 text-[11px] leading-snug text-ink-muted",
            person && "text-center",
          )}
        >
          {arch.description}
        </div>
      ) : null}
      {component?.interfaceNames.length ? (
        <div className="mt-1.5 flex min-w-0 flex-wrap gap-1 border-t border-edge/60 pt-1.5">
          {component.interfaceNames.slice(0, 3).map((name) => (
            <span key={name} className="max-w-28 truncate rounded bg-surface-3 px-1.5 py-0.5 font-mono text-[9px] text-ink-muted">{name}</span>
          ))}
          {component.interfaceNames.length > 3 ? <span className="px-1 py-0.5 font-mono text-[9px] text-ink-faint">+{component.interfaceNames.length - 3}</span> : null}
        </div>
      ) : null}
      {!entity && arch.tech.length > 0 ? (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {arch.tech.slice(0, 4).map((t) => (
            <Badge key={t} tone="neutral">
              {t}
            </Badge>
          ))}
          {arch.tech.length > 4 ? <Badge tone="neutral">+{arch.tech.length - 4}</Badge> : null}
        </div>
      ) : null}
      {component && (component.fileCount > 0 || component.screenCount > 0 || component.routeCount > 0 || component.entityCount > 0) ? (
        <div className="mt-1.5 border-t border-edge/60 pt-1 text-[9px] text-ink-faint">
          {[
            component.fileCount ? `${component.fileCount} files` : "",
            component.screenCount ? `${component.screenCount} screens` : "",
            component.routeCount ? `${component.routeCount} routes` : "",
            component.entityCount ? `${component.entityCount} entities` : "",
          ].filter(Boolean).join(" · ")}
        </div>
      ) : null}
      {data.code ? (
        <div
          className={cn(
            "mt-1.5 flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[9.5px]",
            data.code.auto
              ? "border-dashed border-crystal-400/40 text-crystal-300/80"
              : "border-crystal-400/40 bg-crystal-500/10 text-crystal-300",
          )}
          title={data.code.auto ? "Suggested by name match — not saved yet" : "Linked code module"}
        >
          <FolderGit2 className="h-2.5 w-2.5 shrink-0" />
          <span className="truncate font-mono">{data.code.module}</span>
          <span className="ml-auto shrink-0 opacity-70">{data.code.fileCount}f</span>
        </div>
      ) : null}
      <Handle type="source" position={Position.Bottom} className="!h-2 !w-2 !border-none !bg-edge-strong" />
    </div>
  );
});

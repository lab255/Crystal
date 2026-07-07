import { Handle, Position, type NodeProps } from "@xyflow/react";
import { memo } from "react";
import { FolderGit2 } from "lucide-react";
import { Badge, cn } from "@crystal/ui";
import { KIND_META, accentOf, type ArchRfNode } from "../model.js";

export const LeafNode = memo(function LeafNode({ data, selected }: NodeProps<ArchRfNode>) {
  const arch = data.arch;
  const meta = KIND_META[arch.kind];
  const accent = accentOf(arch);
  const Icon = meta.icon;
  const slot = data.slot;

  const flowBadge =
    data.flow != null && data.flow.step !== null ? (
      <span
        className="absolute -left-2 -top-2 z-10 flex h-5 min-w-5 items-center justify-center rounded-full bg-crystal-500 px-1 font-mono text-[10px] font-bold text-white shadow-md"
        title={data.flow.step === 0 ? "Journey entry" : `Reached at hop ${data.flow.step}`}
      >
        {data.flow.step === 0 ? "▶" : data.flow.step}
      </span>
    ) : null;

  // Slotted (code-linked) nodes fill their reserved LOD footprint: the box
  // already has the size its expansion needs, so zooming in swaps content
  // without moving anything. Typography scales with the slot so the label
  // stays legible from all the way out.
  if (slot) {
    const labelPx = Math.round(Math.min(44, Math.max(18, slot.width / 14)));
    const subPx = Math.round(Math.max(11, labelPx * 0.42));
    return (
      <div
        className={cn(
          "relative flex h-full w-full flex-col rounded-xl border bg-surface-2/95 shadow-md shadow-black/30 transition-shadow",
          selected ? "border-crystal-400 shadow-lg shadow-crystal-500/20" : "border-edge-strong",
          data.flow?.step === null && "opacity-30",
        )}
        style={{ borderLeftWidth: 3, borderLeftColor: accent }}
      >
        {flowBadge}
        <Handle type="target" position={Position.Top} className="!h-2 !w-2 !border-none !bg-edge-strong" />
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1 px-4 text-center">
          <div className="flex min-w-0 items-center gap-2">
            <Icon style={{ color: accent, width: labelPx * 0.8, height: labelPx * 0.8 }} className="shrink-0" />
            <span
              className="truncate font-semibold leading-tight text-ink"
              style={{ fontSize: labelPx }}
            >
              {arch.label}
            </span>
          </div>
          <div
            className="uppercase tracking-wider text-ink-faint"
            style={{ fontSize: subPx }}
          >
            {meta.label}
            {data.code ? ` · ${data.code.fileCount} files` : null}
          </div>
          {arch.description ? (
            <div
              className="line-clamp-2 max-w-full leading-snug text-ink-muted"
              style={{ fontSize: subPx }}
            >
              {arch.description}
            </div>
          ) : null}
          {arch.tech.length > 0 ? (
            <div className="mt-0.5 flex flex-wrap justify-center gap-1">
              {arch.tech.slice(0, 4).map((t) => (
                <Badge key={t} tone="neutral">
                  {t}
                </Badge>
              ))}
              {arch.tech.length > 4 ? <Badge tone="neutral">+{arch.tech.length - 4}</Badge> : null}
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
      className={cn(
        "relative min-w-40 max-w-56 rounded-lg border bg-surface-2/95 px-3 py-2 shadow-md shadow-black/30",
        "transition-shadow",
        selected ? "border-crystal-400 shadow-lg shadow-crystal-500/20" : "border-edge-strong",
        data.flow?.step === null && "opacity-30",
      )}
      style={{ borderLeftWidth: 3, borderLeftColor: accent }}
    >
      {flowBadge}
      <Handle type="target" position={Position.Top} className="!h-2 !w-2 !border-none !bg-edge-strong" />
      <div className="flex items-center gap-2">
        <Icon className="h-3.5 w-3.5 shrink-0" style={{ color: accent }} />
        <div className="truncate text-xs font-semibold text-ink">{arch.label}</div>
      </div>
      <div className="mt-0.5 text-[10px] uppercase tracking-wider text-ink-faint">{meta.label}</div>
      {arch.description ? (
        <div className="mt-1 line-clamp-2 text-[11px] leading-snug text-ink-muted">{arch.description}</div>
      ) : null}
      {arch.tech.length > 0 ? (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {arch.tech.slice(0, 4).map((t) => (
            <Badge key={t} tone="neutral">
              {t}
            </Badge>
          ))}
          {arch.tech.length > 4 ? <Badge tone="neutral">+{arch.tech.length - 4}</Badge> : null}
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

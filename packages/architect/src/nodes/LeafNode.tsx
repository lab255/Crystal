import { Handle, Position, useStore, type NodeProps } from "@xyflow/react";
import { memo, useMemo } from "react";
import { FileCode2, Folder, FolderGit2 } from "lucide-react";
import { Badge, cn } from "@crystal/ui";
import { KIND_META, accentOf, type ArchRfNode } from "../model.js";
import type { BlockPreview } from "../live-code.js";
import { STAGE_TEXT_PX, useLodConfig } from "../lod-config.js";
import { highlightAttrs } from "../use-highlight.js";

/** Natural chip metrics at scale 1 (matches the rendered css below). */
const CHIP_H = 28;
const CHIP_GAP = 6;
/** Estimated chip width for a file name (icon + mono glyphs + padding). */
const chipWidthFor = (name: string, exports: number): number =>
  34 + Math.min(name.length, 26) * 6.3 + (exports > 0 ? 14 : 0);

/**
 * How much the chip grid must shrink for every file to fit the reserved slot.
 * The scale multiplies both chip type and box; 1 = natural size. The floor is
 * unbounded — legibility is judged in `LeafNode` against the configured
 * minimum on-screen text height, not here.
 */
function chipScaleFor(
  slot: { width: number; height: number },
  preview: BlockPreview,
  bottomReserved: number,
): number {
  const availW = Math.max(1, slot.width - 24);
  const availH = Math.max(1, slot.height - 64 - bottomReserved);
  const natural = preview.files.reduce(
    (sum, f) => sum + (chipWidthFor(f.name, f.exports) + CHIP_GAP) * (CHIP_H + CHIP_GAP),
    0,
  );
  if (natural <= 0) return 1;
  return Math.min(1, Math.sqrt((availW * availH) / natural));
}

/** Top directories of the previewed files, for the overview's shape summary. */
function topDirs(preview: BlockPreview, max: number): { dir: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const f of preview.files) {
    const dir = f.dir === "" ? "" : (f.dir.split("/")[0] ?? "");
    counts.set(dir, (counts.get(dir) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([dir, count]) => ({ dir: dir === "" ? "(root)" : `${dir}/`, count }));
}

export const LeafNode = memo(function LeafNode({ data, selected }: NodeProps<ArchRfNode>) {
  const arch = data.arch;
  const meta = KIND_META[arch.kind];
  const accent = accentOf(arch);
  const Icon = meta.icon;
  const slot = data.slot;
  const preview = data.preview;
  const minTextPx = useLodConfig((s) => s.minTextPx);

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

  // Every file gets a chip, shrunk uniformly to fit the reserved area; the
  // grid only yields to the overview when its words would render below the
  // configured minimum on-screen text height — the definition of "too small
  // to be worth drawing" is the user's, not a hardcoded zoom stop.
  const chipScale = useMemo(() => {
    if (!slot || !preview) return 1;
    const bottomReserved = (arch.tech.length > 0 ? 26 : 0) + 28; // tech row + code badge
    return chipScaleFor(slot, preview, bottomReserved);
  }, [slot, preview, arch.tech.length]);
  const chipPx = STAGE_TEXT_PX.chip * chipScale;
  // Selector returns the boolean, so zooming only re-renders nodes that
  // actually cross their own legibility threshold.
  const chipsLegible = useStore((s) => s.transform[2] * chipPx >= minTextPx);
  const showChips = slot != null && preview != null && chipsLegible;

  // Slotted (code-linked) nodes fill their reserved LOD footprint: the box
  // already has the size its expansion needs, so zooming in swaps content
  // without moving anything. Typography scales with the slot so the label
  // stays legible from all the way out.
  if (slot) {
    const labelPx = Math.round(Math.min(44, Math.max(18, slot.width / 14)));
    const subPx = Math.round(Math.max(11, labelPx * 0.42));
    const headerPx = Math.round(Math.min(26, Math.max(16, slot.width / 24)));
    const chipH = Math.max(12, Math.round(CHIP_H * chipScale));
    const chipIconPx = Math.max(7, 12 * chipScale);
    return (
      <div
        {...hlAttrs}
        className={cn(
          "relative flex h-full w-full flex-col rounded-xl border bg-surface-2/95 shadow-md shadow-black/30 transition-shadow",
          selected ? "border-crystal-400 shadow-lg shadow-crystal-500/20" : "border-edge-strong",
          data.flow?.step === null && "opacity-30",
        )}
        style={{ borderLeftWidth: 3, borderLeftColor: accent }}
      >
        {flowBadge}
        <Handle type="target" position={Position.Top} className="!h-2 !w-2 !border-none !bg-edge-strong" />
        {showChips && preview ? (
          <div className="flex min-h-0 flex-1 flex-col gap-1.5 px-3 pt-2.5">
            <div className="flex min-w-0 items-center gap-2">
              <Icon
                style={{ color: accent, width: headerPx * 0.9, height: headerPx * 0.9 }}
                className="shrink-0"
              />
              <span
                className="min-w-0 flex-1 truncate font-semibold leading-tight text-ink"
                style={{ fontSize: headerPx }}
              >
                {arch.label}
              </span>
              <span className="shrink-0 text-[10px] uppercase tracking-wider text-ink-faint">
                {meta.label}
              </span>
            </div>
            <div className="text-[10.5px] text-ink-faint">
              {preview.totalFiles} file{preview.totalFiles === 1 ? "" : "s"} ·{" "}
              {preview.totalExports} export{preview.totalExports === 1 ? "" : "s"}
              {arch.description ? (
                <span className="text-ink-muted"> — {arch.description}</span>
              ) : null}
            </div>
            <div
              className="flex min-h-0 flex-1 flex-wrap content-start overflow-hidden"
              style={{ gap: Math.max(3, CHIP_GAP * chipScale) }}
            >
              {preview.files.map((f) => (
                <span
                  key={`${f.dir}/${f.name}`}
                  title={f.dir ? `${f.dir}/${f.name}` : f.name}
                  className="flex items-center rounded-md border border-edge bg-surface-1/80 font-mono text-ink-muted"
                  style={{
                    height: chipH,
                    fontSize: chipPx,
                    gap: 5 * chipScale,
                    paddingInline: 7 * chipScale,
                  }}
                >
                  <FileCode2
                    className="shrink-0"
                    style={{ color: accent, width: chipIconPx, height: chipIconPx }}
                  />
                  <span className="max-w-40 truncate">{f.name}</span>
                  {f.exports > 0 ? (
                    <span
                      className="text-ink-faint"
                      style={{ fontSize: chipPx * 0.85 }}
                      title={`${f.exports} exports`}
                    >
                      {f.exports}
                    </span>
                  ) : null}
                </span>
              ))}
            </div>
            {arch.tech.length > 0 ? (
              <div className="flex flex-wrap gap-1">
                {arch.tech.slice(0, 4).map((t) => (
                  <Badge key={t} tone="neutral">
                    {t}
                  </Badge>
                ))}
                {arch.tech.length > 4 ? <Badge tone="neutral">+{arch.tech.length - 4}</Badge> : null}
              </div>
            ) : null}
          </div>
        ) : (
          // High-level overview: the same reserved area, spent on what the
          // component *is* — identity, size, internal shape — at type sizes
          // that stay legible where individual file chips no longer would.
          <div className="flex min-h-0 flex-1 flex-col justify-center gap-1.5 px-5 py-3">
            <div className="flex min-w-0 items-center gap-2.5">
              <Icon style={{ color: accent, width: labelPx * 0.8, height: labelPx * 0.8 }} className="shrink-0" />
              <span className="min-w-0 truncate font-semibold leading-tight text-ink" style={{ fontSize: labelPx }}>
                {arch.label}
              </span>
            </div>
            <div className="uppercase tracking-wider text-ink-faint" style={{ fontSize: subPx * 0.85 }}>
              {meta.label}
              {preview ? (
                <span className="normal-case tracking-normal">
                  {" "}
                  · {preview.totalFiles} file{preview.totalFiles === 1 ? "" : "s"} · {preview.totalExports} export
                  {preview.totalExports === 1 ? "" : "s"}
                </span>
              ) : data.code ? (
                <span className="normal-case tracking-normal"> · {data.code.fileCount} files</span>
              ) : null}
            </div>
            {arch.description ? (
              <div className="line-clamp-2 max-w-full leading-snug text-ink-muted" style={{ fontSize: subPx }}>
                {arch.description}
              </div>
            ) : null}
            {preview ? (
              <div className="flex flex-wrap" style={{ gap: 6 }}>
                {topDirs(preview, 4).map(({ dir, count }) => (
                  <span
                    key={dir}
                    className="flex items-center rounded-md border border-edge bg-surface-1/80 font-mono text-ink-muted"
                    style={{ fontSize: subPx * 0.9, gap: 6, paddingInline: 8, height: subPx * 2 }}
                  >
                    <Folder style={{ color: accent, width: subPx * 0.9, height: subPx * 0.9 }} className="shrink-0" />
                    {dir}
                    <span className="text-ink-faint">{count}</span>
                  </span>
                ))}
              </div>
            ) : null}
            {arch.tech.length > 0 ? (
              <div className="mt-0.5 flex flex-wrap gap-1">
                {arch.tech.slice(0, 4).map((t) => (
                  <Badge key={t} tone="neutral">
                    {t}
                  </Badge>
                ))}
                {arch.tech.length > 4 ? <Badge tone="neutral">+{arch.tech.length - 4}</Badge> : null}
              </div>
            ) : null}
          </div>
        )}
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

import { CODE_LOD_LEVELS, type CodeLodLevel } from "@crystal/core";
import { Tooltip, cn } from "@crystal/ui";

/**
 * The global level-of-detail slider: repositories → packages → modules →
 * members. One discrete knob that re-poses the whole map; per-node
 * expand/collapse still works on top of whatever level is set.
 */

const LEVEL_META: Record<CodeLodLevel, { label: string; hint: string }> = {
  repos: { label: "Repos", hint: "Repositories — the workspace repo and any nested repos" },
  packages: { label: "Packages", hint: "Packages and apps with their dependency edges" },
  modules: { label: "Modules", hint: "Every package opened to its files" },
  members: { label: "Members", hint: "Every file opened to its functions, types and constants" },
};

export function LodSlider({
  level,
  onChange,
  counts,
  levels = CODE_LOD_LEVELS,
}: {
  level: CodeLodLevel;
  onChange: (level: CodeLodLevel) => void;
  /** Optional per-level entity counts, shown next to the stop labels. */
  counts?: Partial<Record<CodeLodLevel, number>>;
  /** Which ladder stops to expose (the unified canvas skips "repos"). */
  levels?: readonly CodeLodLevel[];
}) {
  const idx = Math.max(0, levels.indexOf(level));
  return (
    <div className="flex items-center gap-2" data-testid="lod-slider">
      <Tooltip content={`Level of detail — how much of the ${levels.map((l) => LEVEL_META[l].label.toLowerCase()).join(" → ")} ladder is exposed (keys 1–${levels.length})`}>
        <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
          detail
        </span>
      </Tooltip>
      <input
        type="range"
        min={0}
        max={levels.length - 1}
        step={1}
        value={idx}
        onChange={(e) => onChange(levels[Number(e.target.value)] ?? levels[0]!)}
        aria-label="Level of detail"
        aria-valuetext={LEVEL_META[level].label}
        className="h-1 w-24 cursor-pointer appearance-none rounded-full bg-surface-3 accent-crystal-400"
      />
      <div className="flex w-24 items-baseline gap-1">
        <Tooltip content={LEVEL_META[level].hint}>
          <span className="text-[11px] font-semibold text-crystal-300">
            {LEVEL_META[level].label}
          </span>
        </Tooltip>
        {counts?.[level] != null ? (
          <span className="text-[9.5px] tabular-nums text-ink-faint">{counts[level]}</span>
        ) : null}
      </div>
      <div className="flex items-center gap-0.5">
        {levels.map((l, i) => (
          <button
            key={l}
            type="button"
            onClick={() => onChange(l)}
            aria-label={`Detail level: ${LEVEL_META[l].label}`}
            className={cn(
              "h-1.5 w-1.5 rounded-full transition-colors",
              i <= idx ? "bg-crystal-400" : "bg-surface-3 hover:bg-edge-strong",
            )}
          />
        ))}
      </div>
    </div>
  );
}

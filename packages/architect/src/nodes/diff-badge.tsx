import type { CSSProperties } from "react";
import type { DiffMark, DiffMarkKind } from "@crystal/core";
import { Tooltip, cn } from "@crystal/ui";

/**
 * Ref-review ("vs <ref>") decoration shared by the architecture node types —
 * the same vocabulary and tones as the codebase map: green added, red dashed
 * removed (ghost), amber changed.
 */

const TONES: Record<DiffMarkKind, { label: string; badge: string; color: string }> = {
  added: { label: "new", badge: "bg-ok/15 text-ok", color: "var(--color-ok)" },
  removed: { label: "removed", badge: "bg-danger/15 text-danger", color: "var(--color-danger)" },
  changed: { label: "changed", badge: "bg-warn/15 text-warn", color: "var(--color-warn)" },
};

/** Corner pill naming the change; tooltip carries the detail ("8 → 14 files"). */
export function DiffCornerBadge({ mark }: { mark: DiffMark }) {
  const tone = TONES[mark.kind];
  return (
    <Tooltip content={mark.detail ?? `${tone.label} vs the review ref`}>
      <span
        className={cn(
          "absolute -right-2 -top-2 z-10 rounded-full px-1.5 text-[8.5px] leading-4 shadow",
          tone.badge,
          "bg-surface-1",
        )}
      >
        {tone.label}
      </span>
    </Tooltip>
  );
}

/** Border tint for a marked node — merged over the node's own inline style. */
export function diffBorderStyle(mark: DiffMark | undefined): CSSProperties {
  if (!mark) return {};
  return { borderColor: TONES[mark.kind].color };
}

/** Extra classes for a marked node (ghosts render dashed + muted). */
export function diffNodeClass(mark: DiffMark | undefined): string | false {
  return mark?.ghost ? "border-dashed opacity-60" : false;
}

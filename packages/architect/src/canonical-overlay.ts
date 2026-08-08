import {
  reconcileOverlay,
  type ArchNodeOverride,
  type ArchOverlay,
  type ArchitectureGraph,
  type OverlayReconciliation,
} from "@crystal/core";

/** Keep reconciliation's stale-customization report alongside its usable overlay. */
export function reconcileCanonicalOverlay(
  overlay: ArchOverlay,
  derived: ArchitectureGraph,
  extraKnownIds?: Iterable<string>,
): OverlayReconciliation {
  return reconcileOverlay(overlay, derived, extraKnownIds);
}

/** Compact, stable copy for hidden/stale rows in the architecture sidebar. */
export function summarizeOverride(override: ArchNodeOverride | undefined): string {
  if (!override) return "no overrides";
  const parts: string[] = [];
  if (override.x != null && override.y != null) parts.push("position");
  if (override.parentId !== undefined) parts.push("parent");
  if (override.size !== undefined) parts.push("size");
  if (override.label !== undefined) parts.push(`label “${override.label}”`);
  if (override.kind !== undefined) parts.push(`kind ${override.kind}`);
  if (override.description !== undefined) parts.push("description");
  if (override.tech !== undefined) parts.push(`tech (${override.tech.length})`);
  if (override.layer !== undefined) parts.push(`layer ${override.layer ?? "auto"}`);
  if (override.accent !== undefined) parts.push(`accent ${override.accent ?? "auto"}`);
  if (override.href !== undefined) parts.push("link");
  if (override.sim !== undefined) parts.push("simulation");
  if (override.placements !== undefined) {
    parts.push(`placements (${Object.keys(override.placements).length})`);
  }
  return parts.join(" · ") || "no overrides";
}

import type { ArchitectLink } from "@crystal/core";

type CodeMapLevel = NonNullable<ArchitectLink["codemap"]>;

/** Complete patch for a bare legacy codemap URL while workspace state settles. */
export function bareCodeMapPatch(
  linkedWs: string | null,
  activeWs: string | null,
): { view: "codebase"; codemap: CodeMapLevel } {
  const ws = linkedWs ?? activeWs;
  return {
    view: "codebase",
    codemap: ws ? { kind: "workspace", ws } : { kind: "all" },
  };
}

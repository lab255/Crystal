import { Boxes, Database, DoorOpen, Layers, Plug } from "lucide-react";
import type { SystemRole } from "@crystal/core";

/** Display metadata per system role — shared by the canvas, panes and inspector. */
export const ROLE_META: Record<
  SystemRole,
  { label: string; accent: string; icon: typeof Boxes }
> = {
  domain: { label: "Domain", accent: "var(--color-accent-violet)", icon: Boxes },
  integration: { label: "Integration", accent: "var(--color-accent-amber)", icon: Plug },
  data: { label: "Data", accent: "var(--color-accent-emerald)", icon: Database },
  shared: { label: "Shared", accent: "var(--color-accent-slate)", icon: Layers },
  entry: { label: "Entry", accent: "var(--color-accent-cyan)", icon: DoorOpen },
};

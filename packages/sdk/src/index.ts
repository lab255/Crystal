/**
 * @crystal/sdk — embed the Crystal IDE, or compose its pieces yourself.
 *
 * Levels of integration:
 * 1. `mountCrystal(el)` — one call, non-React hosts.
 * 2. `<Crystal />` — the full IDE as a React component.
 * 3. `<CrystalProvider>` + individual modes — build your own shell. Import
 *    modes from their own packages (`@crystal/architect`, `@crystal/orchestrator`,
 *    `@crystal/editor`); they are deliberately not re-exported here so bundlers
 *    can code-split them behind the shell's lazy boundaries.
 * 4. `BridgeClient` + `@crystal/core` — headless access to workspaces, graphs,
 *    boards and agent runs.
 */

export { Crystal, type CrystalProps } from "./Crystal.js";
export { CrystalShell, type CrystalShellProps } from "./CrystalShell.js";
export { mountCrystal, type CrystalInstance } from "./mount.js";
export { CRYSTAL_MODES, MODE_LABELS, type CrystalMode } from "./modes.js";

// Data layer
export {
  BridgeClient,
  CrystalProvider,
  defaultBridgeUrl,
  useAgents,
  useConnectionState,
  useCrystal,
  useNav,
  useNavUpdate,
  useWorkspace,
  type ConnectionState,
  type NavPatch,
} from "@crystal/client";

// Domain model
export * from "@crystal/core";

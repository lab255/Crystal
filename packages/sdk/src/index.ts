/**
 * @crystal/sdk — embed the Crystal IDE, or compose its pieces yourself.
 *
 * Levels of integration:
 * 1. `mountCrystal(el)` — one call, non-React hosts.
 * 2. `<Crystal />` — the full IDE as a React component.
 * 3. `<CrystalProvider>` + individual modes (`ArchitectMode`, `OrchestratorMode`,
 *    `EditorMode`) — build your own shell.
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
  useWorkspace,
  type ConnectionState,
} from "@crystal/client";

// Individual modes for granular embedding
export { ArchitectMode, ArchitectCanvas } from "@crystal/architect";
export { OrchestratorMode, RunView } from "@crystal/orchestrator";
export { EditorMode } from "@crystal/editor";

// Domain model
export * from "@crystal/core";

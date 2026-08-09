export {
  BridgeClient,
  webSocketTransport,
  type BridgeTransport,
  type BridgeTransportFactory,
  type ConnectionState,
} from "./bridge-client.js";
export {
  listBridgeInstances,
  shellBridgeEndpoint,
  tauriBridgeTransport,
  tauriPipeTransport,
  type BridgeInstance,
} from "./tauri-transport.js";
export {
  EMPTY_WORKSPACES,
  FleetClient,
  parseWsKey,
  sidForEndpoint,
  wsKey,
  type FleetClientOptions,
  type FleetClientState,
  type ServerConnection,
} from "./fleet-client.js";
export {
  checkForDesktopUpdate,
  checkForDesktopUpdateNow,
  desktopUpdateStore,
  useDesktopUpdate,
  type DesktopUpdatePhase,
  type DesktopUpdateState,
} from "./desktop-update.js";
export {
  desktopPlatform,
  isDesktop,
  openNewWindow,
  type DesktopPlatform,
} from "./desktop-window.js";
export { useWorkerMemo, type WorkerMemoResult } from "./use-worker-memo.js";
export {
  applyTheme,
  enterKeyAction,
  initTheme,
  settingsStore,
  useComposerKeydown,
  useSettings,
  type AppSettings,
  type EnterBehavior,
  type SettingsState,
  type ThemePreference,
} from "./settings.js";
export {
  createWorkspaceStore,
  type WorkspaceState,
  type WorkspaceStore,
} from "./workspace-store.js";
export {
  createWorkspacesStore,
  type WorkspacesState,
  type WorkspacesStore,
} from "./workspaces-store.js";
export {
  createAgentStore,
  type AgentStartInput,
  type AgentState,
  type AgentStore,
} from "./agent-store.js";
export {
  EMPTY_PROJECT_ENTRIES,
  EMPTY_QUESTIONS,
  EMPTY_RUNS,
  EMPTY_TODOS,
  annotateFleetQuestions,
  createFleetStore,
  type FleetQuestion,
  type FleetState,
  type FleetStore,
} from "./fleet-store.js";
export {
  createTerminalsStore,
  type TermChunk,
  type TerminalTab,
  type TerminalTabKind,
  type TerminalsState,
  type TerminalsStore,
} from "./terminal-store.js";
export { agentEventToChunk, type AgentEventChunk } from "./agent-event-chunk.js";
export {
  questionDeliveryNotice,
  type QuestionDelivery,
} from "./question-delivery.js";
export {
  createWorkflowStore,
  type WorkflowState,
  type WorkflowStore,
} from "./workflow-store.js";
export {
  createGrantsStore,
  type GrantsState,
  type GrantsStore,
} from "./grants-store.js";
export {
  EMPTY_PENDING_PERMISSIONS,
  createPermissionsStore,
  type PermissionsState,
  type PermissionsStore,
} from "./permissions-store.js";
export {
  EMPTY_HUB_EVENTS,
  EMPTY_HUB_PROJECTS,
  EMPTY_HUB_QUESTIONS,
  EMPTY_HUB_RECENTS,
  EMPTY_PROGRAMS,
  createHubStore,
  type HubState,
  type HubStore,
} from "./hub-store.js";
export { InteractiveRunBanner } from "./interactive-banner.js";
export { InteractiveRunTerminal } from "./run-terminal.js";
export { XtermView } from "./xterm-view.js";
export {
  RunTranscript,
  formatRunCost,
  formatRunDuration,
  formatRunTokens,
  type TranscriptDensity,
} from "./run-transcript.js";
export {
  parseUnifiedDiff,
  type DiffHunk,
  type DiffLine,
  type FileDiff,
  type FileDiffStatus,
} from "./diff.js";
export { chainOf } from "./chain.js";
export { ChainTurns } from "./chain-turns.js";
export { MessageComposer, type ComposerSendResult } from "./message-composer.js";
export {
  QuestionCard,
  type QuestionCardOption,
  type QuestionCardProps,
} from "./question-card.js";
export {
  RunSurface,
  branchNameError,
  useRunSurface,
  type ApplyBranchOutcome,
  type RunSurfaceDiff,
  type RunSurfaceProps,
} from "./run-surface.js";
export { createLensStore, type LensState, type LensStore } from "./lens-store.js";
export { createNavStore, type NavPatch, type NavState, type NavStore } from "./nav-store.js";
export { requestOpenFile } from "./open-file.js";
export { useNeedsYou, type NeedsYou, type NeedsYouQuestion } from "./needs-you.js";
export {
  useAttentionJump,
  useFleetNeedsYou,
  type AttentionTarget,
  type FleetNeedsYou,
  type WorkspaceNeedsYou,
} from "./fleet-needs-you.js";
export { useAttentionNotifications } from "./attention-notifier.js";
export {
  RefCombobox,
  RefReviewBar,
  gitRefOptions,
  useGitRefs,
  type GitRefsState,
  type RefComboboxProps,
} from "./git-refs.js";
export {
  useRefReview,
  type RefReviewState,
  type RefSnapshot,
  type RefSnapshotNeed,
} from "./ref-review.js";
export {
  DiagramLegend,
  DiagramShell,
  DiagramToolbarGroup,
  type DiagramLegendEntry,
} from "./diagram/DiagramShell.js";
export {
  formatIdList,
  parseIdList,
  toggleIdInList,
} from "./diagram/selection.js";
export {
  symbolMenuEntries,
  useSymbolMenu,
  type SymbolMenuContext,
  type SymbolMenuGroup,
  type SymbolMenuOptions,
  type SymbolTarget,
} from "./symbol-menu.js";
export {
  createHighlightStore,
  type HighlightState,
  type HighlightStore,
} from "./highlight-store.js";
export {
  CrystalProvider,
  defaultBridgeTarget,
  defaultBridgeUrl,
  useActiveWorkspace,
  useAgents,
  useConnectionState,
  useCrystal,
  useFleet,
  useFleetConnections,
  useGrants,
  usePermissions,
  useHighlight,
  useHighlightUpdate,
  useHub,
  useLens,
  useNav,
  useNavUpdate,
  useTerminals,
  useWorkflows,
  useWorkspace,
  useWorkspaces,
  type CrystalContextValue,
} from "./provider.js";

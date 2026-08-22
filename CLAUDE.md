# Crystal — notes for Claude Code

Crystal is a pnpm-workspace IDE with seven modes (the cross-project Overview — a
dashboard of traffic-light project cards plus the absorbed hub surfaces: the
coordinator chat (program manager, cross-project programs dispatched to per-project
orchestrators) and the questions inbox; architecture diagrammer (three consolidated
views: derived-architecture / codebase / infrastructure, one shared vs-ref review),
surfaces explorer — screens/components/stories/API surface/schemas,
Threads — chat-first agent conversations (questions + tool use inline, workers
nested; `packages/threads`), Monaco editor, quality — test runner + coverage, jobs hub) plus a
bottom terminal panel that runs shells and agent consoles in any open workspace. Read
`README.md` for the product shape; this file is the mechanics.

Shell IA (packages/sdk): the top navbar is a three-lane grid — left context (back/
forward history + new-tab, the active project's menu (`ProjectMenu`: settings /
terminal / copy path / new window / close), the `ProjectSwitcher`, the git-only
`BranchSwitcher`), the search/command bar dead-center, and the global constructs
right (fleet "needs you" pill, questions inbox → Overview inbox, copy-link
(Ctrl/Cmd+L), lens — the `LensBar` owns ALL lens/facet functions incl. suggested
index facets). New views open as native browser tabs on web or real OS windows via
`openNewWindow` (Tauri `new_window` — the sidecar dies with the LAST window).
Level 1 nav is the Slack-style
`WorkspaceRail` (Overview on top, one tile per workspace with its traffic light,
runners/git/terminal toggles + settings at the bottom); level 2 is `ProjectNav` —
one section per facet with its deep-link subviews as subsections,
drag-rearrangeable (order in the settings store), rendered only when a workspace is
entered. The Overview (the one cross-project mode) takes the full width. The
document viewport is locked (html/body overflow hidden, page pinch/ctrl-wheel zoom
suppressed in CrystalShell) — only inner panes scroll, canvases keep their own zoom.

## Commands

- `pnpm dev` — bridge server (ws://127.0.0.1:4517/crystal) + Vite web app (http://localhost:5173)
- `pnpm test` — vitest at the repo root (tests live in `packages/*/src/**/*.test.ts`)
- `pnpm typecheck` — `tsc --noEmit` in every package
- `pnpm --filter @crystal/desktop dev` — Tauri desktop (Rust ≥ 1.77)
- `pnpm --filter @crystal/relay dev|deploy` — the Cloudflare publish relay (wrangler)

Node 24.18 is pinned via `use-node-version` in `.npmrc`; system `node` may be older —
always run things through pnpm.

Releases ship macOS arm64 + Windows x64 (no macOS Intel), are
conventional-commit driven, and cut by `.github/workflows/release.yml` (push to
`main` → `plan` dry-run → `release` environment approval → per-platform
build/sign (+notarize on macOS) → signed updater `latest.json`).
`scripts/release.mjs` is the nx-release stand-in (bump/changelog/tag). Full runbook
+ the secret checklist: `docs/releasing.md`.

## Architecture rules

- Dependency direction: `core`, `ui` ← `client` ← modes
  (`architect`/`threads`/`editor`/`surfaces`/`quality`) ← `sdk` ← apps. `core` is
  pure TS (no React, no Node APIs) — it defines the domain model, the `.crystal` file
  envelope, the bridge protocol (`BridgeMethods` in `packages/core/src/bridge.ts` is the
  single source of truth for both client and server) and the Claude stream-json parser.
  `ui` has no workspace deps; `client` may use its types/primitives (it hosts the shared
  symbol menu), never the reverse.
- The server hosts multiple workspaces (`WorkspaceRegistry`, one runtime per root). Every
  workspace-scoped bridge method takes an optional `ws` id; `BridgeClient.setScope` injects
  the active workspace automatically, so only cross-workspace call sites (e.g. the code
  map's "all workspaces" level) pass `ws` explicitly. Debounced saves must capture `ws` at
  schedule time — a flush can land after the user switches workspaces.
- Transport: by default the bridge listens only on a local IPC pipe (named pipe /
  unix socket, NDJSON frames) and advertises its endpoints in
  `~/.crystal/instances/<pid>.json`; TCP+WebSocket is opt-in via `--listen [host:]port`
  (the dev script passes `--listen 127.0.0.1:4517` for the Vite proxy; non-loopback
  hosts force a bearer token). The desktop sidecar is pipe-only — the webview reaches
  it through the Tauri relay commands (`bridge_connect/send/close` in `lib.rs`), and the
  shell supervises/restarts it (job object reaps the tree; stdin close = graceful stop).
  Agent MCP stays HTTP on an ephemeral loopback port (the Claude CLI can't dial a pipe).
- Heavy compute is off the hot threads: each workspace's `CodeMapAnalyzer` runs in a
  worker thread behind the async facade in `apps/server/src/analysis-host.ts` (degrades
  to in-process when the worker can't boot, e.g. under vitest), and the browser scene
  builds (code map, surfaces system map) run in module Web Workers via `useWorkerMemo`
  (`@crystal/client`) — scene inputs/outputs must stay structured-clonable, so no
  functions in react-flow node data (inject callbacks after the scene lands).
- Packages are consumed **as TypeScript source** (`main: ./src/index.ts`); Vite compiles
  them in the app build. There is no per-package build step.
- Ambient types shared by all packages live in `types/globals.d.ts` (wired via
  `files` in `tsconfig.base.json`).
- UI styling: Tailwind v4 tokens defined in `packages/ui/src/styles.css` (`@theme`). Use
  the semantic utilities (`bg-surface-*`, `text-ink*`, `border-edge*`, accents) — never
  raw hex in components. Every token is a `light-dark()` pair resolved by `color-scheme`
  (OS preference by default; `data-theme` on `<html>` pins a side), so a component that
  honors the tokens is theme-correct for free. Grays are near-neutral by design — don't
  reintroduce blue-tinted surfaces. Terminals (xterm) and Monaco stay dark in both themes.
- App-level preferences live in `packages/client/src/settings.ts` (module-singleton
  zustand store, localStorage): theme, the composer Enter keymap, rail expansion, nav
  section order. Every dispatch/compose textarea must route its keydown through
  `enterKeyAction`/`useComposerKeydown` — Ctrl/Cmd+Enter always sends, Shift/Alt+Enter is
  always a newline, and plain Enter obeys the user's setting; never hand-roll the check.
  The settings dialog (`packages/sdk/src/SettingsDialog.tsx`) is their one UI home.
- Publishing: the bridge can relay itself through a Cloudflare Worker + SQLite Durable
  Object (`apps/relay`; server side `apps/server/src/publish-manager.ts`, settings at
  `~/.crystal/publish.json`). The host dials OUT (`/i/<instance>/host`, pinned bearer
  token) and remote clients ride a per-channel envelope over that one socket — the DO is
  the entire trust boundary (PBKDF2 password verifier + per-IP and global rate limits);
  the bridge's own token/origin checks never see relayed traffic. The envelope types are
  duplicated in `packages/core/src/publish.ts` and `apps/relay/src/protocol.ts` — keep
  them in lockstep. Bridge surface: `publish.status`/`publish.configure` (unscoped) +
  the `publish.changed` event.
- zustand v5: selectors must return stable references — no `?? []` literals inside
  selectors (use module-level empty constants); deriving arrays belongs outside the selector.
- Workflows (the layer above manager/worker runs): rules are pure in
  `packages/core/src/workflow.ts` (templates, stage graph, tracks/branches, spend vs
  budget, the manager's standing prompt); enforcement is `apps/server/src/workflow-engine.ts`
  (persists to app-data `workflows/`, installs `AgentManager.dispatchGuard`, pauses on
  budget exhaustion, queues/delivers user messages into the manager's resume chain).
  Attribution rides the `workflow:<id>` run tag — dispatched workers inherit it, so spend
  is derivable from the run list alone (the UI computes it client-side from the agent
  store). A `WorkerSpec.branch` implies worktree isolation on that named branch (parallel
  tracks); two live workers must never share a track branch.
- Two enforcement seams guard workflow spend. **Pre-flight**: `WorkflowEngine.start` runs
  `apps/server/src/preflight.ts` (rules in `core/preflight.ts`) — marker files imply tools
  (pnpm-lock → pnpm, package.json → node…), each probed against the *agents'* spawn PATH
  (`envWithToolchain`), and the typed report lands on `workflow.env`, in the kickoff
  prompt + `workflow_status` when it has gaps, and on the hub's dispatch report
  (`envGaps`). **Typed turn outcomes**: a settled *manager* turn must have changed
  something — `workflowProgressFingerprint` (stages/tracks/status, worker-run count, the
  workflow's board tasks + open questions; never timestamps or spend) is compared across
  manager settles, `STALL_TURN_LIMIT` consecutive unchanged turns pause the workflow with
  `pausedBy: "stall"`, and a user resume forgives the streak. Both exist because of the
  same field failure: an orchestrator resumed six times against an unchanged board, $9
  gone, the missing-node gap discovered mid-review. Three sibling levers from the same
  retro: steering returns a typed `SteerReceipt` (`interactive`/`resumed`/`queued` +
  `wakeExpected`) and the hub's `message_delivery` **queues by default** (`wake: true` is
  the explicit paid resume — the queue holds *pre-framed* text, so engine notices are
  never dressed as owner words); `WorkflowEngine.compact` retires a long manager
  transcript and reseeds a fresh session from the record + status text (refused while
  runs are live — a settling worker would resume the retired chain and fork
  coordination); and `HubEngine.closeDelivery` is the "settled externally" verb —
  outcome + note recorded first, live workflow cancelled after, which only works because
  `onWorkflowChanged` skips deliveries that are already terminal. A one-shot
  `BUDGET WARNING` notice lands at `BUDGET_WARN_FRACTION` of a workflow budget
  (`budgetWarnedAt`, re-armed on budget change) so the wrap-up happens while there is
  still money to pay for it. Three more levers from the same retro: **premise check** —
  a brief/goal may carry machine-checkable `assert:` lines (`branch`/`ref`/`file`/
  `tool`/`cmd`; rules in `core/premise.ts`, probed by `probeAssertions` in the server's
  preflight.ts at `workflow.start`); the typed report lands on `workflow.premise`, in
  the kickoff prompt + status text, and as `premiseGaps` on the hub dispatch report —
  a false claim in a brief is a $0 fact at dispatch, and unknown assert kinds fail
  loudly rather than reading as held. **Per-run cost cap** — `runCapUsd` on a workflow
  (or delivery) stamps `costCapUsd` onto every run (manager turns, resumed turns via
  `resumeChain`, workers via the `dispatchCostCap` seam beside `dispatchGuard`);
  `AgentManager.enforceCostCap` kills a run live once its streamed usage estimates past
  the cap, reason on `resultText` (interactive runs stream no usage, so they are
  uncapped by construction). **Marginal value per turn** — the engine appends
  `{runId, costUsd, progressed}` to the bounded `workflow.turnLog` at every manager
  settle (progressed = the stall fingerprint moved), and the workflow header renders
  cost-per-turn chips with no-progress turns loud.
- Tool grants are first-class per-workspace data (`core/grants.ts` rules,
  `apps/server/src/grants-store.ts` persistence in app-data `grants.json`): the
  ledger's `allowedTools` patterns ride *every* spawn additively
  (`AgentManager.grantsResolver`, headless and interactive), and permission denials
  detected in the stream (`isPermissionDenial` on error tool_results, tool named via
  the per-run toolUseId→name map) fold per (tool, workflow) through `onToolDenied` —
  "delivery X requested tool Y, denied N times" is durable data instead of
  transcript archaeology. Bridge: `grants.get`/`grants.setTools` + the
  `grants.changed` event. Since the orchestration frontend strip, grants (like
  boards, workflow templates and budget editing) have no dedicated UI — they are
  driven over the bridge/MCP.
- A template stage carries three things beyond its dependencies. `handoff` is the
  artifact it owes the stages downstream — dependencies say *when* a stage may start,
  only the handoff says *what its worker is given*, so it goes into both the producing
  stage's brief and the consuming stage's `Receives:` line. `boardStatus` is the seam to
  the orchestrator board: the column that stage's tasks occupy while it works, rendered
  into the manager's prompt by `boardMappingText` so moving a task is a lookup, not a
  judgement call (`null` = coordination-only, like refine). `x`/`y` are the builder's
  persisted layout — absent means the layered auto-layout owns that stage, which is what
  every built-in relies on. The manager's operating protocol is **generated** from the
  purposes a template actually contains (`stageProtocolLines`), never a fixed script
  naming standard's stage ids — three built-ins (`simple`, `standard`, `advanced`) and
  custom graphs don't share a vocabulary of ids, only of purposes.
- Templates live in three scopes and the *directory decides*, not the record's own
  `scope` field (a file copied between directories would otherwise keep lying about
  where it belongs): built-ins in core, the shared library in
  `~/.crystal/workflow-templates`, and per-project ones under the workspace's app data.
  `GlobalTemplateStore` is one instance per server, held by the registry and handed to
  every `WorkflowEngine`, so a save in one workspace is visible *and announced* in the
  others; `TemplateLibrary` is the per-workspace view over both halves. Saving with a
  different scope **moves** the template — leaving the old copy would put one id in two
  directories and make resolution depend on lookup order. Customising is always a full
  copy (`deriveTemplate`, provenance in `basedOn`), so editing a project's fork can
  never reach the library; and a one-off graph passed to `workflow.start` as `template`
  is snapshotted into that run alone, never persisted.
- The Threads mode (`packages/threads`) is the ONE orchestration frontend: a
  thread = a resume chain (`groupRunsByManager` → `RunNode`), identity = the
  chain-root run id, workers render nested inside their manager's transcript,
  never as rail rows. The rail's one status dot per row is
  `threadIndicator` (needs-input > running > failed > unread > idle) over core's
  `sessionDisplayStatus` with localStorage unread/pins (`thread-unread.ts`).
  The transcript is a pure fold (`transcript-items.ts`) over the SAME
  `RunEvent[]` the console chunker reads: consecutive tool calls coalesce into
  one "Explored N files" work item, questions join their board record by
  (runId, text) and stay in history once answered, `dispatch` events become
  delegation rows. Composers route through client's `messageRun` (workflow:/
  program: tag routing) and must surface the typed `resumed|queued|recorded`
  status. Deep link: `#/threads?thread=<any run id in the chain>`;
  `#/orchestrate/*` parses as permanent aliases (run-carrying tabs → the
  thread, costs/insights → the Overview dashboard). Cost display reuses the
  accounting kernel only (`sessionSubtreeCost`, `rollupRunsUsage`,
  `workflowSpend`, hub `ProgramSpend` as server truth) — no budget-editing UI.
- The hub (the layer above workflows) is **cross-project** — engine unchanged, but
  its UI now lives inside the Overview mode: `#/projects/chat` (`ProgramThread`, a
  plain conversation with the program manager; program picker + create form) and
  `#/projects/inbox` (`QuestionInbox`) — both exported by `@crystal/threads`;
  old `#/hub/...` links are permanent parse aliases. Delivery/budget
  management has no dedicated screens — the manager drives it over MCP. A
  `Program` is one
  high-level epic split into per-project `ProgramDelivery`s, each dispatched as
  a workflow inside that project — from there the project's own orchestrator
  owns its development flow. Rules are pure in `packages/core/src/hub.ts`
  (delivery graph + readiness, spend rollup, the program manager's standing
  prompt, agent-facing rendering); enforcement is registry-scoped in
  `apps/server/src/hub-engine.ts`, which reaches workspaces only through the
  `HubProjects` port (`registryProjects` in server.ts is the one adapter, so the
  whole lifecycle is testable without opening a workspace). Programs persist
  centrally in `~/.crystal/hub/programs` — they outlive any single project.
  Invariants: one live delivery per project at a time — checked across the
  whole *portfolio*, not just one program, since two orchestrators in one repo
  collide on branches and the board whoever sent them (`deliveryReadiness`
  takes the other programs; `dispatch` passes them); a delivery follows its
  workflow's status via `HubEngine.onWorkflowChanged`, routed through the
  registry's broadcast seam in server.ts (not a per-runtime subscription —
  workspaces close and reopen with fresh engines); and completing a delivery
  auto-dispatches whatever it unblocked. Questions are the other feedback edge:
  they land on a project's *board*, not on its workflow, so `onProjectChanged`
  rides `workspace.changed`, diffs the open-question id set per program, and
  wakes the manager with only the new ones (unseen and empty are the same
  thing — a first board write must not emit "no questions"). Answering goes
  through `OrchestrationService.answerQuestion`, which records the answer *and*
  resumes the asking run's session — messaging a delivery steers it but never
  clears a question. The hub is not purely event-driven: `reconcile()` folds
  every live delivery's current workflow through the same path at startup, so
  a workflow that settled while the server was down is still noticed — and when
  a delivery's stored `ws` no longer resolves (the project came back under a new
  id) it reopens the project by root and repins the id, because a delivery
  stuck at `running` holds its project lock against the whole portfolio. Same
  reasoning behind `retryDelivery`: a terminal delivery goes back to `pending`
  (reopening the program if it had settled) so a failure is recoverable instead
  of blocking its dependents forever.
- Waking an agent goes through `AgentManager.deliver`, never a bare
  `resumeChain`: a chain that is mid-turn cannot be resumed (two `--resume`s
  fork the session), so the message is queued and flushed when the turn
  settles. A resumed turn is the *same conversation*: `resumeChain` re-enters
  the chain's worktree (`adoptWorktreePath` — resuming into the plain repo
  would strand the session's own edits; skipped only when another live run
  holds that working copy), and the UI collapses resume chains to one row
  (`groupRunsByManager` faces each chain by its latest turn; `agent.message`
  returns the resumed turn's id so surfaces follow the conversation). Interactive runs (the native Claude TUI on a workspace PTY,
  `run.terminalId` set; `terminalWs` when the hub owns the run but a workspace
  hosts the terminal) are the exception `deliver` handles first: the message
  is typed into the terminal as one bracketed paste — the TUI queues mid-turn
  input itself, so it can never fork. Prompts still never ride argv; they are
  typed in after `INTERACTIVE_PROMPT_DELAY_MS`. The pinned `--session-id`
  is what lets the chain resume *headlessly* after the terminal exits (exit
  settles the run via `settleInteractive`, which flushes queued answers). Every settlement flushes *its own* chain's queue as well as its
  manager's — a worker that asked a question is the chain the answer is
  waiting on. Notices carry a kind: only settlement gets the board-keeping
  tail; a queued message is delivered verbatim.
- `ProgramSpend.stale` is the difference between "cost nothing" and "could not
  be read": a live delivery whose project is closed makes the rollup a lower
  bound, and a budget is never declared exhausted from a number like that.
- Server-side, the two orchestration engines share their mechanical halves
  rather than each growing a copy: `record-store.ts` (a directory of JSON
  records with the serialized read-modify-write — corrupt files are skipped,
  a rejected mutation must not poison the queue, and the change event fires
  only after the write lands), `settled-runs.ts` (a run emits several terminal
  events, so every settle hook needs claim-once + bounded memory) and
  `mcp/jsonrpc.ts` (the MCP handshake and reply shapes). Their *policies* stay
  separate — the lifecycles genuinely differ.
- Two MCP surfaces, both in-process over the loopback HTTP listener: project
  scope at `POST /mcp/<ws>/<runId>` (dispatch/board/workflow tools, see
  `mcp/dispatch-mcp.ts`) and hub scope at `POST /mcp/hub[/<runId>]`
  (`mcp/hub-mcp.ts`). Bare, the hub endpoint is what an **external** central
  agent points at to dispatch epics into any project; with a run id it is
  Crystal's own program-manager session, bound to one program (`boundProgramId`
  — other programs are refused, not silently redirected). The MCP port is
  ephemeral unless `--mcp-port` pins it; agent runs never care (their
  mcp-config is written per run), but an external agent's config does — hence
  the `crystal-mcp` stdio shim (`mcp/stdio-proxy.ts`), which resolves the live
  endpoint from `~/.crystal/instances` per call so one config line survives
  restarts (the desktop sidecar takes a fresh port every launch).
- `AgentManager.deliverToChain` is `deliver` with the outcome typed ("resumed" /
  "queued" / "recorded" — recorded means the text can never be delivered and the durable
  board record is the outcome); question answers and steering surfaces read it. The raw
  `agent.start {resumeSessionId}` API refuses to resume a session whose chain still has a
  live run — that would fork the Claude session.
- Worktree merge-back lives in `apps/server/src/worktree-merge.ts`: predict with
  `git merge-tree --write-tree` (never destructive), land via a real `git merge` in
  whichever worktree has the target branch checked out, or object-level
  (`merge-tree` → `commit-tree` → CAS `update-ref`) when nothing does. Conflict
  resolution replays the merge INTO the run's worktree (markers, `MERGE_HEAD`) and a
  `merge`-purpose agent run — started with `worktreeOfRunId` so it works in that same
  tree — resolves and commits; landing is then a fast-forward.
- Failed runs are classified (`packages/core/src/run-failure.ts`: context overflow /
  usage limit / auth — deliberately narrow regexes; unknown failures stay
  unclassified) and `agent.handoff` recovers overflow: haiku summarizer → fresh
  session seeded with the note, `handoffFromRunId` lineage, same worktree. The
  workflow engine repoints `managerRunId` via `AgentManager.onHandoff`. An
  auth-classified failure parks every queued delivery (`authChanged` event; failed
  threads stay loud in the rail) until a successful run proves the login healed.
- Managed services + watches: model in `packages/core/src/service.ts` (defs +
  watches are repo-durable in `.crystal/services.json`; watch patterns are literal
  alternatives, NEVER regex), supervision in `apps/server/src/service-manager.ts`
  (detached process groups, port pre-probe, desired-state restore with ps-guarded
  orphan reaping, log ring, min-interval-throttled watch fires). The registry wires
  `onWatchFire` → one live `fix`-purpose run per watch, tagged `watch:<id>`.
- Standing tasks (`packages/core/src/standing-task.ts` rules,
  `apps/server/src/standing-tasks.ts` sweeper): scheduled fresh-session fires
  tagged `standing:<id>` — the run list is the fire log; `nextFireAt` treats a
  passed daily slot as due, so missed fires catch up on boot. One live fire
  per task.
- Deep links: every view is addressable via the URL hash (`#/<mode>/<subview>?…`). The
  codec is `packages/core/src/deeplink.ts`, view/selection state lives in the client nav
  store (`useNav`/`useNavUpdate`), and the SDK's `useDeepLinks` syncs store ↔ URL. New
  navigational state belongs in the nav store, not component-local `useState`.
- File writes are conflict-guarded: `fs.read` returns the on-disk `sha`, `fs.write`
  takes `baseSha` and refuses when the file changed since the read (agents and editors
  share trees — external modification is the NORMAL case). The editor keeps its
  dirty/conflict logic in pure `packages/editor/src/editor-state.ts`; any new
  buffer-editing surface must ride the same guard, never a bare `fs.write`.
- Delivery truth is typed end-to-end: `agent.message` returns
  `{status: resumed|queued|recorded}` — `recorded` means the chain can NEVER receive
  the text; MessageComposer keeps the draft and says so. Never collapse the status
  back into a boolean at any seam (that exact collapse silently ate steering once).
  `git.changedFiles`/`changedFilesStatus` resolve user-supplied refs loudly — a typo'd
  ref must error like the vs review, never read as an empty (= clean) diff lens.
- Textual diffs: `git.showFile` serves one file at a ref (null = absent, truncated
  flag, loud on bad refs/binary); the editor's read-only Monaco `DiffView` opens via
  the `crystal:open-diff` CustomEvent (same pattern as `crystal:open-terminal` — how
  packages reach the editor without depending on it). Review surfaces (DiffPanel rows,
  codemap changed/ghost node menus, RefReviewBar's changed-file list) all wire to it.
- The architecture overlay broadcasts `arch.overlayChanged` after every save; the
  client refetches unless its own overlay save is pending. Multi-window editing relies
  on this — a new overlay-writing path must go through the workspace store's debounced
  save (which keeps failed saves dirty in `failedSaves` and retries on flush), never a
  direct `arch.saveOverlay`.
- Shell keyboard: `packages/sdk/src/shortcuts.ts` + `modeShortcutDigit` (modes.ts) are
  the ONE binding table — every advertised hint (ProjectNav, palette, the Shift+/
  cheat-sheet) derives from them; never hand-compute a key hint. Global shortcuts must
  yield to a focused terminal (`.xterm` closest-check at the top of the shell keydown).
  Palette capability actions dispatch `crystal:` CustomEvents (see
  `packages/sdk/src/capabilities.ts`).
- Quality runs are scopeable additively: `quality.run` takes `packageDir` (one package
  job), `testNamePath` (describe-ancestry `-t` pattern), and reports `progress`
  (job n of m), `coverageMissing` + `coveragePathsProbed` on the `QualityRunUpdate`
  shape. The partial-failure contract is load-bearing: some-packages-failed keeps
  `status: "failed"` with `run.error`, and the UI must render that loudly (a green
  count with a broken package is the failure mode being prevented).
- Diagram export lives in `packages/architect/src/export-png.ts` /
  `export-mermaid.ts` (pure generator, stable ordering — exports must diff cleanly)
  behind the toolbar `ExportMenu`; mermaid is only offered on live C4 projections.
- Context menus: anything rendering a function/symbol/file/module composes
  `useContextMenu()` (`@crystal/ui` plumbing) with `useSymbolMenu()` (`@crystal/client`,
  pure builder `symbolMenuEntries` underneath) — view-specific entries on top, the shared
  block below. Never hand-roll pin/open-in-editor/code-map/coverage/copy entries; pass
  view capabilities (`startJourney`, `revealOnDiagram`, `openFile` override…) and `omit`
  groups the view already covers (e.g. `"quality"` inside the quality mode).
- The global lens is the one cross-tool filter: a top-level `lens` deep-link param (sits
  beside `ws`, travels across every mode) whose spec is dimensional tags (`intent:auth`,
  `sys:forms`), a saved workspace facet (`facet:<id>`, persisted in `.crystal/facets.json`),
  or a review diff (`diff:worktree|base|ref:<ref>`). The model + URL codec are pure in
  `packages/core/src/lens.ts` (`LensSpec`, `parse/formatLensParam`, `buildLensMatcher`,
  `systemsInLens`); `packages/client/src/lens-store.ts` resolves a spec to concrete member
  files (tags → code index + `sys:` parts; diff → `git.changedFiles`; facet → its saved
  spec) and hands every view one stable `matcher` via `useLens`. The provider re-resolves
  on lens/workspace change and on `codemap.changed` for diff lenses. Views *dim* non-members
  (surfaces/quality, same treatment as the find box) or *compact* to them (code map);
  membership is gated on the store key matching the active param so a half-switched lens
  never leaks. Don't confuse this with the architecture's own `ArchFacet` (a named view
  over the one canonical diagram, stored in the overlay) — the global lens is
  workspace-scoped and mode-spanning. Never send the matcher or membership functions into
  a scene web worker; derive plain id Sets on the main thread and dim at render time
  (same rule as react-flow node data).

- The code map analyzer EXCLUDES generated code: path heuristics (`generated`/
  `__generated__` segments, `.generated.`/`.pb.ts`/`_pb.ts` names — `isGeneratedCodePath`
  in paths.ts) plus a content sniff of the first ~1200 bytes (`@generated`, `DO NOT
  EDIT`…) skip the TS parse and drop the file from EVERY projection (module lists, deps,
  overview, index, bulk details, both ref-snapshot paths — the working tree's config
  lenses both sides of a vs-ref diff). `.crystal/codemap.json` `{exclude, include}`
  globs override in both directions (`include` wins). The only trace is
  `summary.excluded {files, roots}` (client renders a "hidden" chip). The fs watcher
  still broadcasts `fs.changed` for excluded paths (editor file tree / buffer conflict
  detection depend on it) but fires `codemap.changed` only when a non-excluded code file
  moved — that split is what stops Prisma-regeneration storms; don't collapse it. The
  system overview is memoized per (analysis generation, index generatedAt) — a new
  overview consumer must go through `analyzer.systemOverview`, never bare
  `buildSystemOverview`. Scene-side guards live in `lod-config.ts`
  (file-card/selection-edge caps, MiniMap node ceiling); collapsed modules lay out at
  card size — only expanded modules get their `memberFootprint` slot, and the footprint
  models the capped render (14 expanded + ≤60 cards + overflow), never every file fully
  exposed (a 200-file module's uncapped footprint is ~48k px tall, past what fitView can
  frame at minZoom).

- The architect mode is exactly three views — `architecture`, `codebase`, `infra`
  (legacy `systems`/`diagrams`/`codemap` ids are permanent parse aliases in
  `deeplink.ts`; `?system=` focuses a node and settles into `sel`). The
  architecture view is organized around the **C4 model** (`core/c4.ts`): one
  canvas with three altitudes — System Context / Containers / Components
  (`level` + `scope` deep-link params, default `containers`) — where
  `deriveC4Model` finds the container tier (deployable-signal seeds on *package*
  modules only: serves HTTP, owns routed screens, top of the module import
  graph — merely owning frontend-layer systems is NOT a signal, it only picks
  the variant, or every React library becomes a "web application"; synthetic
  dir modules — `CodeModule.synthetic`, minted for single-package repos —
  never seed; library systems pool into `ctr:shared`; no seeds at all ⇒ ONE
  `ctr:app` container named after the root package, structure lives at
  Components),
  splits detected externals into owned infrastructure (database/cache/queue/
  storage/search/realtime → containers inside the boundary) vs external
  systems, and synthesizes the default `person:user` when screens exist.
  `projectC4` renders one level as a plain `ArchitectureGraph` with
  cross-boundary edges aggregated (`c4rel:` ids) and reports `nodeRollup`/
  `edgeRollup` so diff marks (`rollupC4Marks`) and journey flows
  (`remapFlowProjection` in the architect package) survive every altitude.
  C4-level edits never go through `extractOverlay` — `applyC4Edit`
  (architect `c4-view.ts`) translates them to targeted overlay ops: drags
  pin per level in `overlay.c4Layouts[c4ViewKey]`, field edits become
  `overrides` (aggregate ids count as known via `reconcileOverlay`'s
  `extraKnownIds`), deleting an aggregate is a deliberate no-op. Drafts and
  the surfaces-embedded `ArchPane` still edit the flat composed graph. The
  infra view is presented as the C4 Deployment diagram (view id stays
  `infra`). The
  architecture is ONE canonical graph per workspace, **derived** from
  `codemap.overview` + detected external services (`core/arch-derive.ts` — stable
  canonical ids `sys:`/`ext:<svc>[:<instance>]`/`link:`/`extlink:`/`screen:`/`flow:`;
  named buckets/queues/tables get their own `ext:` instance nodes) and **composed** with
  the user-authored overlay (`core/arch-overlay.ts`, envelope kind `arch-overlay` at
  `.crystal/architecture/overlay.json`). Views edit a plain `ArchitectureGraph`;
  persistence goes through `extractOverlay(derived, rendered, edited, prev)` — only real
  drags become position overrides (auto-layout owns everything else; system cards lay
  out at their card slots — `systemCardSlot` — and derived containers/`c4:` boundaries
  are fitted to their children by `autoLayoutFitted`; there is NO zoom-driven LOD —
  detail is explicit: C4 altitude, the discrete packages/modules/members ladder, and
  per-node expand, with an expansion displacing neighbors view-only), manual nodes/edges and
  hidden ids round-trip, and legacy diagram files migrate losslessly ONCE on the first
  `arch.getOverlay` (files are read, never rewritten; each becomes an `ArchFacet` with
  `sourcePath` so old `?diagram=` links resolve). Never let review ghosts reach
  `extractOverlay` — strip them first, or they persist as manual nodes.

- The deployment model (2026-08-23 revamp): targets are typed per-environment
  records (`ArchDeployTarget` on `ArchEnvironment.targets`; placements
  reference `targetId` and keep `placement.target` as a display-name MIRROR
  that only core normalization writes — `normalizeDeployTargets` in
  `core/arch-deploy.ts`, raw-envelope migration via
  `DATA_MIGRATORS["arch-overlay"]`). Zone/note visibility is environment-
  scoped through `ArchEnvironment.infraNodeIds` — ABSENT means legacy =
  visible everywhere (several bugs came from emitting zero instead); the
  seven zone kinds live in core (`INFRA_ZONE_KINDS`/`isInfraZone`) and are
  filtered out of the architecture canvas + C4 via
  `splitInfraOnly`/`reinjectInfraOnly` (ArchitectMode's
  `transformCanvasCommit` — canvas edits only; draft applies commit
  unchanged). `removeEnvironment` prunes only the REMOVED env's own
  now-unreferenced zones/notes. Deep links: `env=` (id) + `sel=`
  (`node:`/`target:`/`zone:` grammar) + `scope=all` (cross-project).
  Cross-project: `infra.cross` (unscoped, like `codemap.cross`) fans out a
  worker-safe DTO over open workspaces; shared services match by exact
  canonical `ext:` id and are framed as "same detected service TYPE" (never
  same instance unless instance-qualified); layout pins persist in the hub
  record `~/.crystal/hub/infra-overlays/default.json`
  (`infra.crossOverlay.get/save` + `infra.crossChanged {reason}`).
  docker-compose detection: `core/compose-detect.ts` (the `yaml` package is
  a direct core dep; strings in, DTOs out — file I/O stays in
  `apps/server/src/compose-suggestions.ts` behind `infra.composeSuggest`),
  container-image aliases are a second evidence channel on `SERVICE_RULES`
  (normalized exact match only), and the `ComposeSuggestions` band adopts
  via one pure idempotent graph transform that never repoints a user-chosen
  placement. Layout: unpinned targets solve in a dedicated ELK worker
  (`infra-layout.ts` — zones/pins NEVER enter the solve; band order comes
  from ELK partitions ONLY, `layerConstraint` FIRST/LAST crashes on real
  back-edges); the architecture ELK solve runs in its own lazy worker
  (`elk-layout.worker.ts`). Both workers stub `globalThis.document` before
  loading elkjs — its UMD scope-sniff otherwise installs its own
  `self.onmessage` and exports nothing inside a real Worker, and everything
  silently falls back to the main thread (a Vite build probe does NOT prove
  worker runtime; only a live `page.workers()` check does). Overlay reads
  memoize per runtime; writes MUST route through
  `WorkspaceRuntime.saveArchOverlay` (which replaces the memo) — a save
  path that bypasses it resurrects the boot-time overlay and clobbers
  newer edits. Viewport-only commits are suppressed until a session has a
  user edit, so viewing a workspace never dirties its overlay file.

- Ref review ("vs `<ref>`", the `vs` deep-link param) is ONE mechanism across all three
  views: `useRefReview` (client) drives the shared `RefReviewBar` and resolves
  `codemap.snapshotAtRef` — `need: ["overview"]` takes the cheap in-memory blob path,
  `summary`/`surfaces` materialize the ref's tree through the full analyzer (LRU per
  commit); statused changed files always ride along. Diffing is client-side onto the
  shared `DiffMarks` vocabulary (`core/diagram-diff.ts`: added/removed/changed, removed
  = ghosts merged BEFORE layout so deletions occupy space). Marks are plain records —
  worker-safe — keyed by scene ids (`m:`/`f:`/`dep:` on the codebase map, canonical ids
  on architecture/infra).

- Permission modes: spawns default to `--permission-mode acceptEdits`; a profile (or
  dispatch) may request `bypassPermissions`, but the roster's
  `allowBypassPermissions` flag is workspace consent — `AgentManager.gatedPermissionMode`
  downgrades ungranted requests to acceptEdits at every spawn choke point (start,
  prepareInteractive, resumed turns re-resolve per turn). The hub's manager never gets
  bypass (it resolves against the global library, not a workspace roster). Two
  workspace-wide dials sit on top: the roster's `defaultPermissionMode`
  (`defaultModeResolver`) is the mode for runs where neither dispatch nor profile named
  one — setting it to bypass is the "run everything unsandboxed" switch and the only
  lever that lifts the CLI's headless working-directory file restriction (hard-blocked,
  never prompted; still rides the bypass gate) — and the grants ledger's `allowAll` makes
  the permission broker auto-approve every headless prompt (broker policy only: it never
  widens `--allowedTools`, and flipping it on settles already-parked requests via
  `recheckGrants`). The AgentsTab hosts both (roster Mode select, grants panel toggle);
  the UI keeps `defaultPermissionMode: bypassPermissions` and `allowBypassPermissions`
  in step in both directions.

## Gotchas

- A react-flow pane with `onlyRenderVisibleElements` + a swapped-in node array can
  cull EVERYTHING to a blank canvas: if the new scene's nodes all sit outside the
  previously-fitted viewport (the codemap's worker-built full layout landing after
  the initial fitView framed a smaller early scene), zero node elements render — no
  error, store still holds the nodes. Any view with culling that swaps node SETS must
  refit on id-set change (see CodeMapView's guarded swap effect) in addition to the
  `updateNodeInternals` re-registration the ArchitectCanvas documents.

- HTML5 drag-and-drop dies silently in the desktop webview unless Tauri's
  drag-drop handler is disabled: `dragDropEnabled: false` on the main window in
  `tauri.conf.json` AND `.disable_drag_drop_handler()` in `new_window` (lib.rs)
  — keep both in sync. Every in-app drag (nav rearrange, palette drops, infra
  placement) depends on it; nothing uses Tauri's native onDragDropEvent.

- Agent spawns strip `ANTHROPIC_API_KEY` (`claudeSpawnEnv`) so a leaked key can't
  silently switch a subscription login to per-token billing; `CRYSTAL_ALLOW_API_KEY=1`
  opts back in. Keep any new spawn path on that helper.
- Agent prompts are piped to the Claude CLI over **stdin**; never pass user text as a
  shell argument. The CLI binary is resolved by `claude-bin.ts` (own-PATH scan → known
  install dirs → POSIX login shell) because the desktop sidecar inherits a GUI launch
  environment — launchd gives macOS apps a bare PATH, so a bare `spawn("claude")`
  ENOENTs. A resolved native `.exe` is spawned with no shell; only `.cmd` shims go
  through `shell: true`, where cmd.exe CONCATENATES argv unquoted — every arg must
  pass `planClaudeSpawn`'s quoting.
- Child-process `error` handlers (and one on `stdin`) must be attached **synchronously
  after `spawn()`** — the failure event fires next tick, and with an `await` in between
  it becomes an uncaught exception that kills the whole bridge server.
- Spawned agents must not inherit `CLAUDE_CODE_CHILD_SESSION` (see `agentEnv` in
  agent-manager.ts): a bridge server launched from inside a Claude session passes the
  marker through, the CLI then disables transcript saving, and that silently breaks
  `--resume` of an interactive session after its terminal closes *and* transcript-based
  usage harvesting. Interactive PTY spawns pass a **complete** env for the same reason —
  `TerminalManager` must not merge it over `process.env`, which would resurrect the key.
- The server canonicalizes its root with `fs.realpathSync.native` — Windows 8.3 short
  paths crash libuv's recursive watcher if you skip this.
- react-flow requires parents before children in the node array (`topoOrderNodes`), and
  child positions are parent-relative — same convention as the core model.
- Replacing react-flow's `nodes` array while its initial measurement is still flushing
  can drop the pending internals update — nodes stay `visibility: hidden` forever
  (~1-in-3 loads). Any async layout that swaps node arrays right after mount (the
  architect's ELK path) must call `updateNodeInternals(ids)` after each swap.
- elkjs: a hierarchical edge that reaches THROUGH a compound whose `elk.algorithm`
  differs from the parent's (e.g. a rectpacked scope under layered
  `INCLUDE_CHILDREN`) crashes ELK with a minified Java exception. `elk-layout.ts`
  snaps such endpoints to the packed scope's border and drops their routes — keep any
  new edge-building path on that helper. Component packing is also ignored entirely
  under `INCLUDE_CHILDREN`, which is why sparse/hub-heavy scopes get rectpacked at all.
- `finish()` in `agent-manager.ts` must run on process close even when a `result` event
  already settled the run status — it persists the run and emits the terminal event.
  It is also idempotent via `endedAt` (a failed spawn fires both `error` and `close`).
- A release `tauri build` now REQUIRES the updater signing env — with
  `createUpdaterArtifacts` + a `plugins.updater.pubkey` set in `tauri.conf.json`, the
  bundler errors out (it won't emit unsigned archives) unless `TAURI_SIGNING_PRIVATE_KEY`
  (+ `_PASSWORD`) are exported. Locally: `export`-them from `~/.crystal/updater/` (see
  `docs/releasing.md`). `tauri dev` is unaffected (dev makes no updater artifacts).
- Never put XML comments (`<!-- … -->`) in `apps/desktop/src-tauri/entitlements.plist`.
  `codesign` embeds entitlements via AMFI's `AMFIUnserializeXML`, which is stricter than a
  normal plist parser and dies on comments (`syntax error near line N`), failing
  `tauri build` at the signing step. `plutil -lint` passes on comments so it won't catch
  it. Keep the entitlement rationale in `docs/releasing.md`, not the plist.
- Tauri signs only the app's own executables (main binary + `externalBin` sidecar), never
  nested Mach-O under `Contents/Resources`. node-pty's staged prebuild (`pty.node` +
  `spawn-helper`) ships ad-hoc-signed, so notarization rejects it. `scripts/build-sidecar.mjs`
  (step 7) Developer-ID-signs every staged Mach-O with `--options runtime --timestamp` when
  `APPLE_SIGNING_IDENTITY` is set — it must run there (inside `beforeBuildCommand`) because
  the step re-stages `resources/sidecar` each build, wiping anything signed earlier. The
  release job imports the cert into a keychain itself and passes the identity as
  `APPLE_SIGNING_IDENTITY` (not `APPLE_CERTIFICATE` — a duplicate import makes `codesign`
  ambiguous). See `docs/releasing.md`.

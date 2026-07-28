# Crystal — notes for Claude Code

Crystal is a pnpm-workspace IDE with eight modes (cross-project overview with traffic-light
todos, the hub — cross-project programs dispatched to per-project orchestrators,
architecture diagrammer (three consolidated views: derived-architecture / codebase /
infrastructure, one shared vs-ref review), surfaces explorer — screens/components/stories/APIs/schemas,
PM/agent orchestration, Monaco editor, quality — test runner + coverage, jobs hub) plus a
bottom terminal panel that runs shells and agent consoles in any open workspace. Read
`README.md` for the product shape; this file is the mechanics.

## Commands

- `pnpm dev` — bridge server (ws://127.0.0.1:4517/crystal) + Vite web app (http://localhost:5173)
- `pnpm test` — vitest at the repo root (tests live in `packages/*/src/**/*.test.ts`)
- `pnpm typecheck` — `tsc --noEmit` in every package
- `pnpm --filter @crystal/desktop dev` — Tauri desktop (Rust ≥ 1.77)

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
  (`architect`/`orchestrator`/`editor`/`surfaces`/`quality`/`hub`) ← `sdk` ← apps. `core` is
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
  raw hex in components.
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
- The hub (the layer above workflows) is **cross-project**: a `Program` is one
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
- Deep links: every view is addressable via the URL hash (`#/<mode>/<subview>?…`). The
  codec is `packages/core/src/deeplink.ts`, view/selection state lives in the client nav
  store (`useNav`/`useNavUpdate`), and the SDK's `useDeepLinks` syncs store ↔ URL. New
  navigational state belongs in the nav store, not component-local `useState`.
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

- The architect mode is exactly three views — `architecture`, `codebase`, `infra`
  (legacy `systems`/`diagrams`/`codemap` ids are permanent parse aliases in
  `deeplink.ts`; `?system=` focuses a node and settles into `sel`). The
  architecture is ONE canonical graph per workspace, **derived** from
  `codemap.overview` + detected external services (`core/arch-derive.ts` — stable
  canonical ids `sys:`/`ext:<svc>[:<instance>]`/`link:`/`extlink:`/`screen:`/`flow:`;
  named buckets/queues/tables get their own `ext:` instance nodes) and **composed** with
  the user-authored overlay (`core/arch-overlay.ts`, envelope kind `arch-overlay` at
  `.crystal/architecture/overlay.json`). Views edit a plain `ArchitectureGraph`;
  persistence goes through `extractOverlay(derived, rendered, edited, prev)` — only real
  drags become position overrides (auto-layout owns everything else, laid out at
  reserved LOD footprints so zoom-into-code never reflows), manual nodes/edges and
  hidden ids round-trip, and legacy diagram files migrate losslessly ONCE on the first
  `arch.getOverlay` (files are read, never rewritten; each becomes an `ArchFacet` with
  `sourcePath` so old `?diagram=` links resolve). Never let review ghosts reach
  `extractOverlay` — strip them first, or they persist as manual nodes.

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
  bypass (it resolves against the global library, not a workspace roster).

## Gotchas

- `apps/server/src/agent-manager.ts` contains a NUL byte in a string literal, so
  ripgrep/Grep treats it as binary — search it with `grep -a` (or Read), not the Grep
  tool.
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

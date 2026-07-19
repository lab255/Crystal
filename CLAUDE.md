# Crystal — notes for Claude Code

Crystal is a pnpm-workspace IDE with seven modes (cross-project overview with traffic-light
todos, architecture diagrammer, surfaces explorer — screens/components/stories/APIs/schemas,
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

## Architecture rules

- Dependency direction: `core`, `ui` ← `client` ← modes
  (`architect`/`orchestrator`/`editor`/`surfaces`/`quality`) ← `sdk` ← apps. `core` is
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

## Gotchas

- Agent prompts are piped to the Claude CLI over **stdin**; never pass user text as a
  shell argument. On Windows the CLI is resolved via `where.exe` and a native `.exe` is
  spawned with no shell; only `.cmd` shims go through `shell: true`, where cmd.exe
  CONCATENATES argv unquoted — every arg must pass `planClaudeSpawn`'s quoting.
- Child-process `error` handlers (and one on `stdin`) must be attached **synchronously
  after `spawn()`** — the failure event fires next tick, and with an `await` in between
  it becomes an uncaught exception that kills the whole bridge server.
- The server canonicalizes its root with `fs.realpathSync.native` — Windows 8.3 short
  paths crash libuv's recursive watcher if you skip this.
- react-flow requires parents before children in the node array (`topoOrderNodes`), and
  child positions are parent-relative — same convention as the core model.
- `finish()` in `agent-manager.ts` must run on process close even when a `result` event
  already settled the run status — it persists the run and emits the terminal event.
  It is also idempotent via `endedAt` (a failed spawn fires both `error` and `close`).

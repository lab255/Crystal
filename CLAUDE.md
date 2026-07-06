# Crystal — notes for Claude Code

Crystal is a pnpm-workspace IDE with three modes (architecture diagrammer, PM/agent
orchestration, Monaco editor). Read `README.md` for the product shape; this file is the
mechanics.

## Commands

- `pnpm dev` — bridge server (ws://127.0.0.1:4517/crystal) + Vite web app (http://localhost:5173)
- `pnpm test` — vitest at the repo root (tests live in `packages/*/src/**/*.test.ts`)
- `pnpm typecheck` — `tsc --noEmit` in every package
- `pnpm --filter @crystal/desktop dev` — Tauri desktop (Rust ≥ 1.77)

Node 24.18 is pinned via `use-node-version` in `.npmrc`; system `node` may be older —
always run things through pnpm.

## Architecture rules

- Dependency direction: `core` ← `client` ← modes (`architect`/`orchestrator`/`editor`) ← `sdk` ← apps.
  `core` is pure TS (no React, no Node APIs) — it defines the domain model, the `.crystal`
  file envelope, the bridge protocol (`BridgeMethods` in `packages/core/src/bridge.ts` is
  the single source of truth for both client and server) and the Claude stream-json parser.
- The server hosts multiple workspaces (`WorkspaceRegistry`, one runtime per root). Every
  workspace-scoped bridge method takes an optional `ws` id; `BridgeClient.setScope` injects
  the active workspace automatically, so only cross-workspace call sites (e.g. the code
  map's "all workspaces" level) pass `ws` explicitly. Debounced saves must capture `ws` at
  schedule time — a flush can land after the user switches workspaces.
- Packages are consumed **as TypeScript source** (`main: ./src/index.ts`); Vite compiles
  them in the app build. There is no per-package build step.
- Ambient types shared by all packages live in `types/globals.d.ts` (wired via
  `files` in `tsconfig.base.json`).
- UI styling: Tailwind v4 tokens defined in `packages/ui/src/styles.css` (`@theme`). Use
  the semantic utilities (`bg-surface-*`, `text-ink*`, `border-edge*`, accents) — never
  raw hex in components.
- zustand v5: selectors must return stable references — no `?? []` literals inside
  selectors (use module-level empty constants); deriving arrays belongs outside the selector.
- Deep links: every view is addressable via the URL hash (`#/<mode>/<subview>?…`). The
  codec is `packages/core/src/deeplink.ts`, view/selection state lives in the client nav
  store (`useNav`/`useNavUpdate`), and the SDK's `useDeepLinks` syncs store ↔ URL. New
  navigational state belongs in the nav store, not component-local `useState`.

## Gotchas

- Agent prompts are piped to the Claude CLI over **stdin**; never pass user text as a
  shell argument (Windows spawns use `shell: true` for the `.cmd` shim).
- The server canonicalizes its root with `fs.realpathSync.native` — Windows 8.3 short
  paths crash libuv's recursive watcher if you skip this.
- react-flow requires parents before children in the node array (`topoOrderNodes`), and
  child positions are parent-relative — same convention as the core model.
- `finish()` in `agent-manager.ts` must run on process close even when a `result` event
  already settled the run status — it persists the run and emits the terminal event.

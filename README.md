# Crystal

**A multi-facet IDE for building systems and their software.**

[![Latest release](https://img.shields.io/github/v/release/lab255/Crystal)](https://github.com/lab255/Crystal/releases/latest)
[![Release pipeline](https://github.com/lab255/Crystal/actions/workflows/release.yml/badge.svg)](https://github.com/lab255/Crystal/actions/workflows/release.yml)

Most IDEs are built around one projection of a system: its code. Crystal treats code as
one facet among several. The same workspace can be approached as an **architecture** (what
exists and how it connects), as **work** (what's being built, by whom — human or agent),
and as **code** (the files themselves). Changing facets doesn't change context: diagrams,
boards and code all live in your repos and version with them.

## Install

Grab the desktop app from the
[latest release](https://github.com/lab255/Crystal/releases/latest):

- **macOS** (Apple Silicon) — `Crystal_<version>_aarch64.dmg`, signed and notarized
- **Windows** (x64) — `Crystal_<version>_x64-setup.exe` (no Authenticode signature
  yet, so SmartScreen will warn on first run)

The app updates itself: it checks the latest GitHub release on launch and installs
in place (every update is verified against the signing key baked into the app).
macOS Intel is not built; a Linux leg comes later.

Agent features (orchestration, workflows, fix/index jobs) drive the
[Claude Code CLI](https://claude.com/claude-code) — install it and log in once,
and Crystal finds it on PATH.

## Run from source

Requires pnpm ≥ 9 (Node 24 is fetched automatically via `.npmrc`).

```sh
pnpm install
pnpm dev          # bridge server (ws://127.0.0.1:4517) + web app (http://localhost:5173)
```

Open http://localhost:5173. The workspace served is this repo — Crystal dogfoods
itself. To point the bridge at another workspace:

```sh
pnpm --filter @crystal/server exec tsx src/index.ts --root /path/to/your/product
```

Desktop shell in dev (needs Rust ≥ 1.77):

```sh
pnpm --filter @crystal/desktop dev
```

Tests and checks:

```sh
pnpm test         # vitest (core model, stream parsing, graph ops)
pnpm typecheck    # tsc across all packages
```

## The modes

One workspace, seven ways in. `Ctrl+K` opens the command palette, `Ctrl+1…7`
switches modes, and a drag-resizable bottom panel runs terminals and agent
consoles in any open workspace.

| Mode | What it is |
| --- | --- |
| **Overview** | The cross-project level: a dashboard of traffic-light project cards, the **coordinator chat** — a program-manager agent that splits a high-level epic into per-project deliveries, sequences them (`dependsOn`, so a shared contract lands before its consumers start), dispatches each into that project's own orchestrator, and rolls spend up against one program budget — and the **questions inbox**, where every agent question from every project lands with one-click answers. External agents can drive the same hub over MCP: point Claude Code in any terminal at the hub endpoint and it can dispatch epics into any project this server knows. |
| **Architecture** | Three views over one canonical graph, **derived from the source** and composed with your hand-authored overlay. *Architecture* is a [C4](https://c4model.com) canvas — System Context, Containers, Components on one surface, with containers detected from deployable signals and externals split into owned infrastructure vs external systems. *Codebase* is the live code map — packages → modules → files → exported symbols with import edges, re-analyzed as the code changes on disk. *Infrastructure* is the C4 Deployment view: components grouped by environment with dependencies detected from the code. Built for making calls: dependency cycles, layering violations and coupling hot-spots tinted on the canvas, and **ref review** — pick a branch or commit and any view diffs against it, additions/removals/changes marked in place. |
| **Surfaces** | Everything the product presents to the outside world. The *System Map* puts the full stack on one canvas — screens, API routes, data systems and integrations in layer bands, per-screen call edges traced through the component call graph down to the exact serving route, with **drift badges** on screens whose calls match no served route. Then *Screens* (routed pages with a live dev-server preview per route), *Components* (exported React components ranked by usage), *Stories* (with live Storybook renders), *APIs* (every served route, its call-graph flamegraph, and every caller), and *Schemas* (zod, prisma, mongoose, model interfaces). |
| **Orchestrate** | Boards + agent orchestration. Tasks hand off to Claude Code with live streaming output, tool traces, cost and history. Runs can be **isolated in disposable git worktrees** — parallel-safe, live diff, conflict-aware **one-click merge back** (predicted non-destructively via `git merge-tree`, with agent-driven conflict resolution when needed). Agents ask **structured questions** answered without forking the session; failures are classified with a recovery action (context overflow → summarized handoff to a fresh session). Above the runs sit **workflows**: a stage graph driven by one long-lived manager session, authored in a drag-and-drop builder, with budgets, a per-run cost cap, stall detection, and cost-per-turn visibility. Templates come as built-ins, a machine-wide shared library, and per-project forks. |
| **Code** | Editor with file tree (git status decorations), tabs, quick-open (`Ctrl+P`) and three keybinding profiles: VS Code, IntelliJ, Vim. Monaco underneath. |
| **Quality** | The workspace's own test suite run from inside Crystal (vitest / jest / `test` script — detected, never assumed), per-test results streaming live, failures unfolding in place, single-test re-runs from the context menu. *Coverage* renders istanbul output as a banded directory tree with clickable uncovered-line ranges. |
| **Jobs** | Agent jobs (intent indexing, architecture surveys — scoped to your diff by default), **managed services** (dev servers / Storybook / watchers supervised by the bridge — they outlive the browser tab, restart with the server, and can carry **watches**: literal log patterns that wake a fix agent with the log tail as context), and **standing tasks** (scheduled agent work — "daily at 03:00: bump deps, run the suite" — each fire a fresh worktree-isolated session; missed slots catch up on boot). |

Two things bind the modes together:

- **Right-click means the same thing everywhere.** Any rendered function, symbol,
  file or module — a code-map chip, a component row, a test case, a flamegraph
  frame — opens the shared context menu: pin the cross-view highlight (it rides
  the URL, so it's shareable), open in the editor at the exact line, drill the
  code map to it, jump to its coverage, copy a `file#symbol` reference. Views
  stack their own actions on top, so the vocabulary never drifts between modes.
- **The lens** is the one cross-mode filter: dimensional tags (`intent:auth`),
  a saved facet, or a diff (`vs worktree`, `vs main`, `vs <ref>`). Set it once
  and every view dims or compacts to the matching slice of the codebase.

Every view is addressable — mode, selection, lens and all — via the URL hash,
so any spot in the IDE is a link you can send.

## Everything is a file

Crystal writes durable state into the workspace, so it belongs to the repo:

```
.crystal/
  workspace.json          # workspace manifest (repos, name)
  architecture/
    overlay.json          # your overlay on the derived architecture
  projects/*.json         # boards + tasks
  facets.json             # saved lens facets
  services.json           # managed services + their watches
  standing-tasks.json     # scheduled agent work
```

Ephemeral state (agent run history, event logs) goes to `~/.crystal/workspaces/<id>/`;
cross-project programs persist in `~/.crystal/hub/` and shared workflow templates in
`~/.crystal/workflow-templates/` — they outlive any single project.

## Layout

```
apps/
  server/      @crystal/server      the bridge: fs, git, .crystal state, agent sessions, MCP
  web/         @crystal/web         web shell (Vite + React 19 + Tailwind 4)
  desktop/     @crystal/desktop     Tauri 2 shell (bundled sidecar server, auto-update)
  relay/       @crystal/relay       Cloudflare Worker relay for publishing a bridge to the web
packages/
  core/        @crystal/core        domain model, .crystal file format, bridge + agent protocols (zod)
  client/      @crystal/client      BridgeClient + zustand stores + React hooks + shared symbol menu
  ui/          @crystal/ui          design system (Radix + Tailwind theme)
  architect/   @crystal/architect   architecture mode
  orchestrator/@crystal/orchestrator orchestrate mode
  editor/      @crystal/editor      code mode
  surfaces/    @crystal/surfaces    surfaces mode
  quality/     @crystal/quality     quality mode
  hub/         @crystal/hub         coordinator chat + questions inbox (Overview surfaces)
  sdk/         @crystal/sdk         the embeddable IDE shell
```

The bridge listens on a local IPC pipe by default (the desktop app is pipe-only);
TCP + WebSocket is opt-in via `--listen [host:]port` — `pnpm dev` passes
`--listen 127.0.0.1:4517` for the Vite proxy. Analysis runs in worker threads on
the server and module Web Workers in the browser, so neither side's hot path
blocks on it.

## Packaged desktop build

The bridge server is bundled as a standalone sidecar executable (Node SEA), so
the installer has no Node.js prerequisite:

```sh
pnpm --filter @crystal/server build:sidecar   # single-file crystal-server binary
pnpm --filter @crystal/desktop build          # dmg / NSIS installer via Tauri
```

A release-style build requires the updater signing env (this is intentional — it
mirrors CI); see [docs/releasing.md](docs/releasing.md). The packaged app serves
`$CRYSTAL_ROOT` if set, else `~/CrystalWorkspace`.

## Embedding Crystal

The whole IDE is a component. From a React app:

```tsx
import { Crystal } from "@crystal/sdk";
import "@crystal/ui/styles.css";

<div style={{ height: "100vh" }}>
  <Crystal url="ws://127.0.0.1:4517/crystal" initialMode="architect" />
</div>;
```

From anything else:

```ts
import { mountCrystal } from "@crystal/sdk";
const app = mountCrystal(document.getElementById("crystal")!);
```

Or compose facets yourself — `CrystalProvider` plus any of the mode components
(imported from `@crystal/architect`, `@crystal/orchestrator`, `@crystal/editor`,
`@crystal/surfaces`, `@crystal/quality` so bundlers can code-split them), or go
headless with `BridgeClient` and the `@crystal/core` model. All packages build
to publishable ESM + type declarations (`pnpm -r build`).

## Agent execution

Runs are spawned as `claude -p --output-format stream-json --verbose --permission-mode acceptEdits`
(plus `--mcp-config … --allowedTools mcp__crystal` for manager and task-bound runs, since
headless runs cannot answer permission prompts) in the chosen repo, with the prompt piped
over stdin (never shell-interpolated). The NDJSON stream is normalized into a stable
`AgentEvent` union, broadcast live over the bridge, and persisted for replay. Session ids
are captured so runs can be resumed.

**Interactive is the default dispatch**: the same agent as the native Claude TUI on a
PTY in the terminal panel — a task's "Run", a workflow's "Start", a program's "Start in
terminal"; headless stays one button away for fire-and-forget and worktree-isolated
runs. The session keeps its Crystal MCP tools, so decisions are still **logged on the
board** with `ask_question` — but the agent puts them to you natively in the terminal,
and closes the board copy once you answer there. After the terminal closes, the
session's pinned id lets the same conversation continue headlessly, and its token bill
is harvested from the session transcript so interactive work rolls up like any other
run. Messaging any settled run resumes its session as a new *turn of the same
conversation* — the run list shows one row per session, and a resumed turn re-enters
the chain's worktree. Agents waiting on you are surfaced everywhere: yellow traffic
lights, "waiting on you" chips, question previews on board cards.

Spend is attributed as it happens: the Orchestrate **Costs** tab slices the workspace's
bill along one axis — epic, human owner, workflow, agent profile, or any
`dimension:value` tag the board's labels carry — with per-model splits, live-run
markers, and a residual "No task" row so the total always reconciles. Programs roll the
same numbers up across projects in the Overview. A workspace can opt into
`bypassPermissions` runs (the roster's **Bypass** toggle, off by default); without the
toggle such requests are downgraded to `acceptEdits` at every spawn.

With **worktree isolation** enabled, the run executes in a disposable `git worktree`
under `~/.crystal/…/worktrees/<run-id>` instead of the repo itself: parallel runs never
collide, the run view shows a live diff, and the worktree can be discarded in one
click. Landing the work back is first-class: the run view predicts the merge
non-destructively (`git merge-tree` — target branch, ahead/behind, the exact files that
would conflict) and merges in one click. Predicted conflicts route to **agent-driven
resolution**: the target is merged *into* the run's worktree with standard markers, a
`merge`-purpose run resolves and commits them in place, and the landing becomes a
fast-forward.

## Shipping

Desktop releases are cut by [`release.yml`](.github/workflows/release.yml):
conventional-commit driven, push-to-`main` plus an environment approval gate.
The pipeline bumps the version, writes the changelog, builds and signs both
platforms (macOS notarized), and publishes a signed `latest.json` updater
manifest — installed apps pick the release up automatically. Runbook and
one-time secret setup: [docs/releasing.md](docs/releasing.md).

# Crystal

**A multi-facet IDE for building systems and their software.**

Most IDEs are built around one projection of a system: its code. Crystal treats code as
one facet among several. The same workspace can be approached as an **architecture** (what
exists and how it connects), as **work** (what's being built, by whom — human or agent),
and as **code** (the files themselves). Changing facets doesn't change context: diagrams,
boards and code all live in your repos and version with them.

## The modes

| Mode | What it is | Built on |
| --- | --- | --- |
| **Architecture** | Four views. *Systems*: the **logical architecture overview** — the codebase clustered into systems (authentication, submission, external integrations…) by directory structure + the semantic code index, each card showing the exports the rest of the code consumes, the systems and external services it leans on, and weighted inter-system links. Built for making calls: **insights** (dependency cycles tinted on the canvas, layering violations, coupling hot-spots, orphans), **ref review** (diff the systems against a branch/commit — what a change adds, drops or reshapes), and one-click **materialize to diagram**. *Diagrams*: hand-authored, with nesting, grouping, drag-in/drag-out containment, typed edges (sync / async / data / dependency), auto-layout, inspector — plus **ref review**: pick a commit or branch (a PR head) and its code architecture is snapshotted into a draft, diffed against the current diagram in a split pane with every change listed. *Infrastructure*: a per-environment service map — components grouped by deployment target, with **dependencies detected from the code** overlaid: module-import edges between placed components and the external services (databases, caches, queues, SaaS APIs) their npm imports imply. *Code map*: architecture **derived from the source itself** — modules and their import edges, drill into a module's files, drill into a file's exports (functions, classes, interfaces, enums, types) and import neighborhood. The code map is live: it re-analyzes and re-renders as the codebase changes on disk. | `@xyflow/react` + dagre; TypeScript compiler API |
| **Orchestrate** | Project boards + agent orchestration: tasks link to repos and architecture nodes, and can be handed to Claude Code with live streaming output, tool-call traces, cost and history. Runs can be **isolated in disposable git worktrees** — parallel-safe, with a live diff view and one-click discard. | Claude Code CLI (`claude -p --output-format stream-json`) |
| **Code** | Editor with file tree (git status decorations), tabs, quick-open (`Ctrl+P`) and three keybinding profiles: VS Code, IntelliJ, Vim | Monaco (+ `monaco-vim`) |
| **Surfaces** | Everything the product presents to the outside world, in six views. *System Map*: the **full stack on one navigable canvas** — frontend systems with their screens, backend systems with their served API routes, data systems and integrations in stacked layer bands, with per-screen call edges traced through the component call graph (hooks and API-client wrappers included) down to the exact serving route. Screens whose calls match no served route get a **drift badge**. Click selects and dims non-neighbors, double-click jumps to the screens view / API explorer / architecture view, and an embedded inspector shows a screen's outgoing calls, a system's endpoints, an endpoint's callers. *Screens*: routed pages detected from Next conventions / react-router configs, with a **live dev-server preview** embedded per route. *Components*: exported React components ranked by usage, cross-linked to their definition, import sites, stories and screens. *Stories*: CSF stories grouped by title with a **live Storybook render** per story. *APIs*: every served route — definition, an interactive call-graph flamegraph, and every caller attributed to its system. *Schemas*: zod objects, prisma models, mongoose schemas and model interfaces with their fields inline. A toggleable **architecture pane** sits side by side with every view — callers and integrations clicked anywhere highlight their system there. | TypeScript compiler API; iframes onto your own dev servers |
| **Quality** | The workspace's own test suite run from inside Crystal (vitest / jest / `test` script — detected, never assumed), with per-test results streaming live, failures unfolding in place (message, expected/received, jump-to-line), and single-file / single-test re-runs from the context menu. *Coverage* renders whatever istanbul output exists — produced here or by your own `--coverage` run — as a banded directory tree with clickable uncovered-line ranges. | the workspace's own runner, JSON reporters, istanbul output |

Global: `Ctrl+K` command palette, `Ctrl+1…7` mode switching. **Right-click means the
same thing everywhere**: any rendered function, symbol, file or module — a code-map
chip, a system's exports, a component row, a test case, a coverage path, a flamegraph
frame — opens the shared context menu: pin the cross-view highlight (shareable, it
rides the URL), open in the editor at the exact line, drill the code map to it, jump
to its coverage (or straight to the test runner for test files), and copy a
`file#symbol` reference. Views stack their own actions on top (run this test, start a
journey, open live preview…), so the vocabulary never drifts between modes.

## Everything is a file

Crystal writes durable state into the workspace, so it belongs to the repo:

```
.crystal/
  workspace.json        # workspace manifest (repos, name)
  architecture/*.json   # diagrams
  projects/*.json       # boards + tasks
```

Ephemeral state (agent run history and event logs) goes to `~/.crystal/workspaces/<id>/`.

## Layout

```
apps/
  server/      @crystal/server    bridge: fs, git, .crystal state, agent sessions (WS on :4517)
  web/         @crystal/web       standalone shell (Vite + React 19 + Tailwind 4)
  desktop/     @crystal/desktop   Tauri 2 shell
packages/
  core/        @crystal/core      domain model, .crystal file format, bridge + agent protocols (zod)
  client/      @crystal/client    BridgeClient + zustand stores + React hooks + the shared symbol context menu
  ui/          @crystal/ui        design system (Radix + Tailwind theme)
  architect/   @crystal/architect architecture mode
  orchestrator/@crystal/orchestrator orchestrate mode
  editor/      @crystal/editor    code mode
  surfaces/    @crystal/surfaces  surfaces mode (system map, screens, components, stories, APIs, schemas)
  quality/     @crystal/quality   quality mode (test runner, coverage)
  sdk/         @crystal/sdk       the embeddable IDE
```

## Run it

Requires pnpm ≥ 9 (Node 24 is fetched automatically via `.npmrc`) and the
[Claude Code CLI](https://claude.com/claude-code) on PATH for agent runs.

```sh
pnpm install
pnpm dev          # bridge server (:4517) + web app (:5173)
```

Open http://localhost:5173. The workspace served is this repo — Crystal dogfoods itself
(see the *Crystal Overview* diagram and the *Crystal* board).

To point the bridge at another workspace:

```sh
pnpm --filter @crystal/server exec tsx src/index.ts --root C:\path\to\your\product
```

Desktop (needs Rust ≥ 1.77):

```sh
pnpm --filter @crystal/desktop dev     # dev shell over the running web app
```

Packaged desktop build — the bridge server is bundled as a standalone sidecar
executable (Node SEA), so the installer has no Node.js prerequisite:

```sh
pnpm --filter @crystal/server build:sidecar   # single-file crystal-server.exe
pnpm --filter @crystal/desktop build          # NSIS installer via Tauri
```

The packaged app serves `%CRYSTAL_ROOT%` if set, else `~/CrystalWorkspace`.

Tests and checks:

```sh
pnpm test         # vitest (core model, stream parsing, graph ops)
pnpm typecheck    # tsc across all packages
```

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
headless with `BridgeClient` and the `@crystal/core` model. All packages build to publishable ESM + type declarations
(`pnpm -r build`).

## Agent execution

Runs are spawned as `claude -p --output-format stream-json --verbose --permission-mode acceptEdits`
(plus `--mcp-config … --allowedTools mcp__crystal` for manager and task-bound runs, since
headless runs cannot answer permission prompts) in the chosen repo, with the prompt piped
over stdin (never shell-interpolated). The
NDJSON stream is normalized into a stable `AgentEvent` union, broadcast live over the
bridge, and persisted for replay. Session ids are captured so runs can be resumed.

With **worktree isolation** enabled, the run executes in a disposable
`git worktree` under `~/.crystal/…/worktrees/<run-id>` instead of the repo itself:
parallel runs never collide, the run view shows a live diff (tracked and untracked
files), and the worktree can be discarded in one click.

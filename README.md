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
| **Hub** | The layer *above* projects: one high-level epic split into per-project **deliveries**, each handed to that project's own orchestrator, which then runs its full development flow inside the project (refine → plan/design → develop/review on parallel branches → merge → release). Deliveries are sequenced against each other (`dependsOn`), so a shared contract lands before its consumers start — a completed delivery auto-dispatches whatever it unblocked. Spend rolls up across every project against one program budget, and pausing a program pauses the live project workflows with it. Optionally driven by a **program manager** session — an agent that owns the split and the sequencing — and by an **external agent over MCP**: point Claude Code (in any terminal) at the hub endpoint and it can dispatch epics into any project this server knows. | the same workflow engine, per project; in-process MCP over loopback HTTP |
| **Orchestrate** | Project boards + agent orchestration: tasks link to repos and architecture nodes, and can be handed to Claude Code with live streaming output, tool-call traces, cost and history. Runs can be **isolated in disposable git worktrees** — parallel-safe, with a live diff view, conflict-aware **one-click merge back** (predicted via `git merge-tree`, with agent-driven conflict resolution when it would conflict) and confirm-guarded discard. Agents ask **structured questions** (one-click answer options, delivered back into the running session without forking it), recoverable failures are **classified with a recovery action** (context overflow → summarized handoff to a fresh session; usage limit → reset time; dead login → reconnect hint), and an **Insights** tab charts spend/tokens/runs over time, split by model and purpose — computed client-side from the run list. Above the runs sit **workflows**: a stage graph driven by one long-lived manager session, authored in a **drag-and-drop builder** — drag stages from a palette onto the canvas, draw the arrows, and give each one its *handoff* (the artifact it owes the next stage) and its **board column**, so the graph and the board are two views of the same progress. Templates come in three flavours: three built-ins (a linear **simple** chain, the parallel-track **standard** one, and an **advanced** shape with research, per-track tests, and review + security + CI gates), a **shared library** every project on the machine can start from, and **per-project** forks — plus a one-off "customise for this run" that tweaks a graph for a single workflow without touching the template. | `@xyflow/react`; Claude Code CLI (`claude -p --output-format stream-json`) |
| **Code** | Editor with file tree (git status decorations), tabs, quick-open (`Ctrl+P`) and three keybinding profiles: VS Code, IntelliJ, Vim | Monaco (+ `monaco-vim`) |
| **Surfaces** | Everything the product presents to the outside world, in six views. *System Map*: the **full stack on one navigable canvas** — frontend systems with their screens, backend systems with their served API routes, data systems and integrations in stacked layer bands, with per-screen call edges traced through the component call graph (hooks and API-client wrappers included) down to the exact serving route. Screens whose calls match no served route get a **drift badge**. Click selects and dims non-neighbors, double-click jumps to the screens view / API explorer / architecture view, and an embedded inspector shows a screen's outgoing calls, a system's endpoints, an endpoint's callers. *Screens*: routed pages detected from Next conventions / react-router configs, with a **live dev-server preview** embedded per route. *Components*: exported React components ranked by usage, cross-linked to their definition, import sites, stories and screens. *Stories*: CSF stories grouped by title with a **live Storybook render** per story. *APIs*: every served route — definition, an interactive call-graph flamegraph, and every caller attributed to its system. *Schemas*: zod objects, prisma models, mongoose schemas and model interfaces with their fields inline. A toggleable **architecture pane** sits side by side with every view — callers and integrations clicked anywhere highlight their system there. | TypeScript compiler API; iframes onto your own dev servers |
| **Jobs** | Agent jobs, **managed services** and **standing tasks**. Jobs: intent indexing and architecture surveys, scoped to your diff by default. Standing tasks: scheduled agent work ("daily at 03:00: bump deps, run the suite") — each fire is a fresh session (worktree-isolated by default) tagged `standing:<id>` so the run list doubles as the fire log; missed slots catch up when the server is back. Services: dev servers / Storybook / watchers supervised by the bridge server — they outlive the browser tab, restart with the server (crash-safe: orphaned process groups are reaped with a pid-reuse guard), pre-probe their port, and stream a bounded log ring. Any service can carry **watches**: literal log patterns (never regex) or on-crash triggers that wake a fix agent with the log tail as context — throttled, one live run per watch. | node child processes (detached groups) |
| **Quality** | The workspace's own test suite run from inside Crystal (vitest / jest / `test` script — detected, never assumed), with per-test results streaming live, failures unfolding in place (message, expected/received, jump-to-line), and single-file / single-test re-runs from the context menu. *Coverage* renders whatever istanbul output exists — produced here or by your own `--coverage` run — as a banded directory tree with clickable uncovered-line ranges. | the workspace's own runner, JSON reporters, istanbul output |

Global: `Ctrl+K` command palette, `Ctrl+1…8` mode switching. **Right-click means the
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
  services.json         # managed services + their watches
  standing-tasks.json   # scheduled agent work
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

**Interactive is the default dispatch**: the same agent as the native Claude TUI on a
PTY in the (drag-resizable) terminal panel — a task's "Run", a workflow's "Start", a
program's "Start in terminal"; headless stays one button away for fire-and-forget and
worktree-isolated runs. The session keeps its Crystal MCP tools, so decisions
are still **logged on the board** with `ask_question` — but the agent puts them to you
natively with AskUserQuestion in the terminal, and closes the board copy with
`resolve_question` once you answer there. Answers given from the board or hub are typed
straight into the live terminal; after it closes, the session's pinned id lets the same
conversation continue headlessly, and its token bill is harvested from the session
transcript so interactive work costs roll up like any other run. Messaging any settled
run resumes its session as a new *turn of the same conversation* — the run list shows
one row per session (with a turn count), a resumed turn re-enters the chain's worktree,
and the surface follows the conversation to the newest turn. Agents waiting on you
are surfaced everywhere: yellow traffic lights, a "waiting on you" chip on overview
cards, question previews on board cards, and a one-click "Start manager" recovery when
a board has READY work but no live manager.

Spend is attributed as it happens: the Orchestrate **Costs** tab slices the workspace's
bill along one axis — epic, human owner, workflow, agent profile, or any `dimension:value`
tag the board's labels carry (multi-dimensional: a task tagged `area:ui` and `area:db`
bills both slices in full) — with per-model splits, live-run markers, and a residual
"No task" row so the total always reconciles. Programs roll the same numbers up across
projects in the Hub. A workspace can also opt into `bypassPermissions` runs (the
roster's **Bypass** toggle, off by default): profiles may then run with
`--dangerously-skip-permissions`; without the toggle such requests are downgraded to
`acceptEdits`.

With **worktree isolation** enabled, the run executes in a disposable
`git worktree` under `~/.crystal/…/worktrees/<run-id>` instead of the repo itself:
parallel runs never collide, the run view shows a live diff (tracked and untracked
files), and the worktree can be discarded in one click.

Landing the work back is first-class: the run view predicts the merge
non-destructively (`git merge-tree` — target branch, ahead/behind, the exact
files that would conflict) and merges in one click, auto-committing dirty state.
When the target branch has a checkout the merge runs there (working tree stays
coherent); when it has none, the merge is object-level (`merge-tree` →
`commit-tree` → compare-and-swap `update-ref`) and no working tree is ever
materialized. Predicted conflicts route to **agent-driven resolution**: the
target is merged *into* the run's worktree with standard markers, a `merge`-purpose
run resolves and commits them in place, and the landing becomes a fast-forward
(abortable at any point before the resolution commit).

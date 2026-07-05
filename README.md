# Crystal

**A multi-facet IDE for building systems and their software.**

Most IDEs are built around one projection of a system: its code. Crystal treats code as
one facet among several. The same workspace can be approached as an **architecture** (what
exists and how it connects), as **work** (what's being built, by whom — human or agent),
and as **code** (the files themselves). Changing facets doesn't change context: diagrams,
boards and code all live in your repos and version with them.

## The three modes

| Mode | What it is | Built on |
| --- | --- | --- |
| **Architecture** | Diagrammer with nesting, grouping, drag-in/drag-out containment, typed edges (sync / async / data / dependency), auto-layout, inspector | `@xyflow/react` + dagre |
| **Orchestrate** | Project boards + agent orchestration: tasks link to repos and architecture nodes, and can be handed to Claude Code with live streaming output, tool-call traces, cost and history | Claude Code CLI (`claude -p --output-format stream-json`) |
| **Code** | Editor with file tree, tabs, quick-open (`Ctrl+P`) and three keybinding profiles: VS Code, IntelliJ, Vim | Monaco (+ `monaco-vim`) |

Global: `Ctrl+K` command palette, `Ctrl+1/2/3` mode switching.

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
  client/      @crystal/client    BridgeClient + zustand stores + React hooks
  ui/          @crystal/ui        design system (Radix + Tailwind theme)
  architect/   @crystal/architect architecture mode
  orchestrator/@crystal/orchestrator orchestrate mode
  editor/      @crystal/editor    code mode
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
pnpm --filter @crystal/desktop dev
```

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

Or compose facets yourself — `CrystalProvider` plus any of `ArchitectMode`,
`OrchestratorMode`, `EditorMode`, or go headless with `BridgeClient` and the
`@crystal/core` model.

## Agent execution

Runs are spawned as `claude -p --output-format stream-json --verbose --permission-mode acceptEdits`
in the chosen repo, with the prompt piped over stdin (never shell-interpolated). The
NDJSON stream is normalized into a stable `AgentEvent` union, broadcast live over the
bridge, and persisted for replay. Session ids are captured so runs can be resumed.

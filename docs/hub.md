# The hub — one agent, every project

Crystal's orchestration stack has three layers. Two of them already existed:

| Layer | Unit | Driven by | Lives in |
| --- | --- | --- | --- |
| Run | one agent turn | the CLI | `AgentManager` |
| Workflow | one goal, one repo | a **manager** session | `WorkflowEngine`, per workspace |
| **Program** | one epic, many repos | you, a **program manager**, or an external agent over MCP | `HubEngine`, once per server |

A **program** is a high-level epic. It is split into **deliveries** — one per
project — and each delivery is dispatched as a *workflow inside that project*.
From that moment the project's own orchestrator owns the development flow
there: refine, plan and design, develop and review on parallel branches, merge,
release. The hub never reaches into a project's work; it decides what each
project is asked for, in what order, and against what budget.

```
program "SSO everywhere"                      ~/.crystal/hub/programs/prog_….json
  ├── delivery → auth-service   → workflow → manager → workers   (repo A)
  └── delivery → web-console    → workflow → manager → workers   (repo B)
       dependsOn: the auth delivery
```

## Pointing an agent at it

Two ways in. Both reach the same toolset.

**Recommended — the stdio shim.** It finds whichever Crystal server is running
(via the discovery files each one writes to `~/.crystal/instances`) and relays
to it, so the config never goes stale:

```sh
claude mcp add crystal-hub -- crystal-mcp
claude mcp add crystal-hub -- crystal-mcp --root /path/to/repo   # prefer that server
```

`crystal-mcp` is the `bin` of `@crystal/server`, built by `pnpm --filter
@crystal/server build` (`dist/crystal-mcp.cjs`) and staged into the desktop
app's resources by `scripts/build-sidecar.mjs`. From a checkout, or when it is
not on your PATH, point at the bundle (or run it through tsx):

```sh
claude mcp add crystal-hub -- node /path/to/crystal/apps/server/dist/crystal-mcp.cjs
```

**Direct HTTP**, when you want no shim in the path:

```
POST http://127.0.0.1:<mcpPort>/mcp/hub
```

```sh
claude mcp add --transport http crystal-hub http://127.0.0.1:4321/mcp/hub
```

The port is **ephemeral by default** — Crystal's own agent runs get an
mcp-config written per run, so they never care, but a config written once does.
Under the desktop app the sidecar takes a fresh port every launch, which is
exactly what the shim is for; for a long-lived server, pin it instead:

```sh
crystal-server --root <repo> --mcp-port 4321      # or CRYSTAL_MCP_PORT=4321
```

The live URL is also in the Hub mode's *Agent endpoint* dialog, in the server's
startup log, and in the instance discovery file
(`~/.crystal/instances/<pid>.json`, field `hubMcpUrl`).

### The toolset

| Tool | What it does |
| --- | --- |
| `list_projects` | Every project this server can address — open workspaces (with ids) and the reopen list |
| `open_project` | Bring a project under management by absolute root path |
| `project_board` | One project's board: epics, tasks, blockers, cost |
| `dispatch_epic` | **The headline tool.** One project, one goal → a program created and dispatched in one call |
| `create_program` / `add_delivery` / `remove_delivery` | Build a multi-project program; `dependsOn` sequences the deliveries |
| `dispatch_program` | Start every unblocked delivery; blocked ones are reported with the reason and start themselves later |
| `program_status` | Deliveries, blockers, what is ready, spend vs budget. Omit the id for the whole portfolio |
| `message_delivery` | Send a note into a running project orchestrator's session |
| `retry_delivery` | Queue a **failed** delivery again — the way out of a failure that would otherwise block its dependents forever |
| `answer_question` | Answer a question a project stopped for: recorded on its board, handed back to the run that asked, which resumes |
| `set_program_paused` / `set_program_budget` / `set_delivery_budget` / `cancel_program` | Control |
| `complete_program` | Declare the outcome with a summary |

Dispatching to a project that is not open opens it first, so a program can span
projects this server has never loaded.

## The rules that make it safe to leave running

- **One live delivery per project, across the whole portfolio.** Two
  orchestrators in one repo collide on branches, worktrees and the task board —
  whether or not the same program sent them — so a delivery into a busy project
  is refused with the reason (naming the program that holds it) rather than
  queued silently.
- **Dependencies gate dispatch, and completion releases it.** A delivery whose
  dependencies have not *completed* is never started; when one completes, the
  deliveries it unblocked are dispatched automatically — nobody has to be
  watching. A failed or cancelled dependency blocks forever, on purpose: that
  is a decision for the owner.
- **Pausing a program pauses its project workflows**, so the spend actually
  stops rather than only new dispatches.
- **The budget is checked on every change**, not only on settlement — a program
  that outruns its ceiling while its workflows are still going is paused, and
  raising the budget releases it (a deliberate user hold stays held). If a live
  delivery's project is closed its cost cannot be read, so the rollup is marked
  incomplete and the budget is *not* judged from it — under-reported spend must
  never look like headroom.
- **A program settles itself** once every delivery is terminal, so it never
  waits on an agent that may not come back.
- **Events are an optimisation, not the source of truth.** At startup the hub
  re-reads every live delivery's workflow and folds it through the same path a
  live event takes, so work that finished while the server was down is picked
  up rather than left `running` forever.
- **A failure is not a dead end.** A delivery that ends `failed` (or
  `cancelled`) blocks every delivery that depends on it, so `retry_delivery`
  puts it back to `pending` and reopens the program if it had already settled.
  The failed attempt's workflow and runs stay in the project, and **its cost
  still counts**: the delivery remembers every workflow it has run, so a retry
  never hands it a budget it has already spent. A `completed` delivery is
  refused — re-running it would drop the summary its dependents were
  dispatched with.
- **Questions escalate.** When a project's orchestrator (or one of its
  workers) calls `ask_question`, it stops and waits for a human — and no other
  project can unblock it. Those questions are derived from each live delivery's
  board and surfaced on the program: in `program_status` under *NEEDS AN
  ANSWER*, in the Hub UI as a callout that jumps straight to the task, and as a
  wake-up for the program manager (which often *can* settle them — a shared
  contract is the program's call, not one project's). Answer with
  `answer_question` (or inline in the Hub UI): the answer is written to that
  project's board *and* handed back to the run that stopped, which resumes
  where it left off. Steering a delivery with `message_delivery` does not clear
  a question — only answering does.

## The program manager

Optional, and orthogonal to the MCP surface: a Crystal-hosted session that owns
one program — an interactive, resume-chained run whose endpoint is
`/mcp/hub/<runId>`, bound to that program (other programs are refused, not
silently redirected). It is woken when a delivery settles, exactly as a
workflow manager is woken when a worker settles, so it never polls. It is rooted
in `~/.crystal/hub`, not in any repo: it coordinates, it does not edit code.

Start one from the Hub mode, or `hub.startManager` over the bridge.

## In the UI

`Hub` is a top-level mode (`Ctrl+2`, `#/hub/programs`), above the workspace
hierarchy alongside Overview — it neither reads nor writes the active
workspace, and switching workspaces does not remount it.

- **Programs** — list, then a program's deliveries with their project, status,
  blockers, spend and the program-manager transcript. Unanswered questions from
  the projects are called out at the top (and counted in the header, so "3
  waiting on you" is visible from any mode via the rail badge).
- A delivery that **failed** carries its own recovery on the row (and in its
  context menu): retry queues it again and the next dispatch gives it a fresh
  workflow, so one failure does not strand everything downstream of it.
- Finished programs can be **removed** from the hub; the project workflows they
  dispatched, and every run they billed, stay where they ran.
- **Projects** — the portfolio from the other side: every project and what it
  is currently carrying, across all programs.
- Right-click a delivery to cross into the project that owns it: its workflow
  in Orchestrate, its board, its runs, its architecture. Every jump switches
  the active workspace first, then navigates — the same rule the code map
  follows at its "all workspaces" level.
- Deep links carry the selection: `#/hub/programs?program=…&delivery=…`.

## Where the code is

| Concern | File |
| --- | --- |
| Model, readiness, spend, prompts, rendering (pure) | `packages/core/src/hub.ts` |
| Lifecycle, persistence, wake-ups, budget | `apps/server/src/hub-engine.ts` |
| MCP tools | `apps/server/src/mcp/hub-mcp.ts` |
| Endpoint routing + the `HubProjects` adapter | `apps/server/src/mcp/http.ts`, `apps/server/src/server.ts` |
| `crystal-mcp` stdio shim | `apps/server/src/mcp/stdio-proxy.ts`, `apps/server/src/mcp-cli.ts` |
| Bridge methods (`hub.*`, all unscoped) | `packages/core/src/bridge.ts` |
| Client store | `packages/client/src/hub-store.ts` |
| UI | `packages/hub/` |

# The middle: agent operations core — design

Scope: the *middle* of the loop only — who runs (agent profiles), where you watch
and steer a run (the unified run surface), and how one client operates many
bridges (the fleet layer). The *ends* — capture-in and review-verbs/attention
queue — are deliberately out of scope here; this layer is designed so they can
land later as projections (the queue) and as one extra pane action set (review),
without reshaping anything below.

Three tracks, ordered. A and B are independent of each other; C rides on both
being stable. Each track ships standalone.

---

## Track A — Agent profiles: durable named agents

Today an "agent" is a dispatch config that evaporates with the run. A partial
profile concept already exists — `AgentProfileSchema` in
`packages/core/src/agent-profile.ts` (id, name, kind, model, skills, tags), a
per-workspace roster in `.crystal/agents.json`, `matchAgent` for tag-based
auto-assignment, and `AgentRun.agentId` stored for attribution. What's missing
is standing behavior, capability policy, a shared scope, and a single
resolution path.

### A1. Schema

Extend `AgentProfileSchema`:

```ts
{
  id, name, kind, model, skills, tags,          // existing
  appendPrompt?: string,       // standing instructions → --append-system-prompt
  allowedTools?: string[],     // merged over ALLOWED_RUN_TOOLS
  disallowedTools?: string[],  // → --disallowedTools (never passed today)
  permissionMode?: "acceptEdits" | "plan" | "default",  // today hardcoded acceptEdits
  defaults?: { purpose?: RunPurpose; isolation?: "worktree" | "none" },
  scope: "project" | "library",
}
```

Not on the profile: cwd (per-dispatch), branch (workflow-track owned), budget
(workflow/program owned). A profile is *who*, never *where* or *how much*.

### A2. Storage: two scopes, directory decides

Mirror the template-library pattern (`apps/server/src/template-library.ts`),
which already solved every problem profiles have — including the header comment
there that argues profiles belong in the `TemplateDir` family (wholesale save,
no read-modify-write races), not `JsonRecordStore`:

- **Project scope**: stays in `.crystal/agents.json` (repo-versioned — a team's
  agents travel with the repo, same philosophy as boards and diagrams). The
  roster wrapper (`defaultAgentId`, `defaultHuman`) stays here too: defaults
  are workspace policy, not profile data.
- **Library scope**: `~/.crystal/agents/<id>.json` via a `GlobalAgentStore`
  held by the registry (one per server, like `GlobalTemplateStore`), announced
  across workspaces on save. Per-workspace `AgentLibrary` view merges: project
  wins on id conflict; save-with-different-scope **moves** the record
  (delete-from-other-scope, exactly like templates — one id must never live in
  two directories).

### A3. One resolution path

`roster.agents.find(a => a.id === agentId)` is duplicated in four places
(`server.ts:476,490,604`, `workflow-engine.ts:237`). Replace with one
`resolveProfile(agentId) → ProfileOverlay` on the runtime (backed by
`AgentLibrary`), returning `{ model, skills, appendPrompt, allowedTools,
disallowedTools, permissionMode, extraTags: ["agent:<id>"] }`. `AgentManager`
applies the overlay in both `start` and `interactive` paths.

The **`agent:<id>` tag** is the payoff: spend/attribution per profile falls out
of the existing tag index (`runsWithTag` + `rollupRunsUsage`) with zero new
metering — same trick as `workflow:<id>` and `program:<id>`.

### A4. Spawn plumbing

`claudeRunArgs` / `claudeInteractiveArgs` (`agent-manager.ts`) gain
`appendSystemPrompt`, `disallowedTools`, `permissionMode`, and allowedTools
merge — threaded exactly the way `model` already is. Standing prompt goes via
`--append-system-prompt` flag, *not* stdin-prompt concatenation (the current
`skills` hack): it must survive `--resume` turns, which re-send the prompt but
not our concatenation. All argv still passes `planClaudeSpawn` quoting; prompt
text itself stays on stdin.

### A5. Named agents in workflows and the hub

- `WorkerSpec` (+ the `dispatch_worker` MCP schema and the `CRYSTAL_DISPATCH:`
  marker) gains `agentId`. Manager prompts list the roster (name, kind, tags,
  model) via a new `rosterText()` next to `boardMappingText` — assigning an
  agent becomes a lookup, not a judgement call, same principle as board columns.
- `WorkflowStageDef.model` stays but gains a sibling `agentId` — a stage can
  name *who*, not just which model. Model remains the fallback.
- Kill the hardcoded `"opus"` defaults (`workflow-engine.ts:235`,
  `hub-engine.ts:792,828`): the manager runs as `roster.managerAgentId ??
  defaultAgentId`, falling back to the current behavior only when no roster
  resolves.

### A6. UI

The Orchestrate **Agents** tab becomes the roster surface, not just a dispatch
form: left pane lists profiles (project + library sections, spend-per-profile
from the `agent:` tag), right pane is the profile editor (name, model picker,
appendPrompt, tool toggles, scope selector) with the existing DispatchPanel
below it — dispatch gains profile + model pickers (today it passes no
`agentId` at all; only TaskDetail does). `matchAgent` auto-assignment is
unchanged and now has more signal (profile tags).

---

## Track B — One run surface

Today a run is watched in five half-overlapping places: orchestrator
`RunView` (transcript + collapsed diff, *no way to talk to the run*), the
terminal-panel agent console (composer, but flattened one-line chunks), hub
`ProgramDetail` (transcript + its own composer + its own turn strip), workflow
tab (same again), and Jobs' hand-rolled `ActiveJobs` list. Four near-identical
composers, two turn strips, two formatter sets, three run-list renderings.

### B1. `RunSurface` in `@crystal/client`

One component, three regions, replacing RunView's stack:

```
┌─ header: StatusDot · prompt headline · purpose · model · agent · cost/tokens/turns · Cancel ─┐
│ Activity ── transcript (RunTranscript) or PTY handoff (InteractiveRunBanner)                 │
│ Conversation ── ChainTurns strip + MessageComposer                                           │
│ Changes ── per-file diff (only when worktreePath)  [Apply as branch · Refresh · Discard]     │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

- **Activity** switches on `run.terminalId` — `InteractiveRunBanner` already
  encodes that decision; it stays the seam. The console's one-line density
  (`agentEventToChunk`) becomes a compact mode of `RunTranscript`, not a
  parallel renderer.
- **ChainTurns**: one shared component + a `chainOf(runs, run)` selector in
  core (both existing turn strips hand-derive the chain by tag filter + sort).
- **Changes**: split `agent.diff`'s unified blob per-file client-side (no
  server change) — file list, colored hunks, click-a-file → open in editor.
  Apply-as-branch gets a real dialog (today: `window.prompt`); Discard gets a
  confirm (today: fires immediately). This per-file structure is the substrate
  the review verbs land on later; the verbs themselves are "the ends".

### B2. `agent.message` — the missing generic steer

There is no way to message a plain run; workflow/hub composers each have their
own bridge method. Add `agent.message { runId, text }`: server-side it is a
thin wrapper over `AgentManager.deliver` on the run's chain — which already
handles every hard case (mid-turn queueing, interactive paste-into-TUI,
settlement flush). `workflow.message` / `hub.message` / `hub.messageDelivery`
stay — they add manager-notice framing and queue persistence `deliver` alone
doesn't — but the UI collapses to one `MessageComposer` + a `messageRun(run,
text)` adapter that picks the method by run tag (workflow tag → workflow
route, program tag → hub route, else `agent.message`).

### B3. Consolidation and the Jobs fold

- `RunList` is already prop-generic with 3 call sites; it gains an optional
  `ws` badge column (needed by Track C and the future queue) and absorbs
  Jobs' `ActiveJobs` (purpose filter chips on the Runs tab: all · manage ·
  develop · index · survey…). Jobs mode keeps its dispatch cards and scope
  logic but drops its run list; whether the mode itself survives is an IA
  call for later — nothing below depends on it.
- The survey→architecture import loop in Jobs is the only *client-side*
  completion side-effect in the app. Leave it, but note: any future
  post-settlement automation belongs server-side on the `settled-runs`
  claim-once hook, not in a polling component.
- Delete the duplicate formatters (`orchestrator/src/prompt.ts` copies of
  `formatRunCost/Tokens/Duration`) and the duplicated RunList+RunView layout
  in OrchestratorMode/AgentsTab (one `RunsPane` composition).

Hub `ProgramDetail` and `WorkflowsTab` then render `RunSurface` instead of
their bespoke transcript+composer stacks — same surface for a worker, a
workflow manager, and a program manager.

---

## Track C — Fleet: one client, many bridges

The invariant that makes this tractable: **per-workspace modes stay
single-server; only the cross-project layer becomes fleet-aware.** A mode
tree (architect/surfaces/orchestrate/editor/quality) always renders against
exactly one `(server, workspace)` pair — views, scoped stores, and the
`client.scope` convention are untouched. Overview, Hub, the workspace tabs,
the terminal panel, and fleet-store aggregate across servers.

### C1. Server identity + instance-file hygiene (server-side, ships alone)

- Mint a `serverId` (uid) per boot and a human `name` (hostname + primary
  root basename); stamp both into `~/.crystal/instances/<pid>.json`.
- **Rewrite the instance file on every `workspaces.changed`** — today `roots`
  is a boot-time snapshot that goes stale on the first open/close, which
  poisons any discovery UI. Add the live workspace id list alongside roots.
- Sweep on write, not only on read (`sweepInstances` currently runs only from
  the stdio proxy and pipe-claim paths).
- Fix the machine-global `~/.crystal/open-workspaces.json` clobber: two
  concurrent servers overwrite each other's open set. Key the persisted open
  set per server flavor (e.g. by claimed pipe name), keep `recents` merged
  last-writer (recents are genuinely shared).

### C2. Client fleet layer

- Fix `BridgeClient` first, it has a latent bug the fleet will hit instantly:
  `close()` doesn't cancel a scheduled retry and `open()` never checks
  `closedByUser`, so a client closed during backoff resurrects itself. Track
  the timer handle; guard `open()`.
- `FleetClient`: owns N `BridgeClient`s keyed by `serverId`, each with its own
  transport + token. Discovery: desktop — a Tauri command lists
  `~/.crystal/instances` (the Rust relay's `RelayState` already supports N
  pipe connections; `bridge_connect` just needs an endpoint argument); web —
  own-origin bridge plus explicitly added `ws://` endpoints (the Vite proxy
  can only ever reach one, so remote bridges are added by URL + token).
- Tokens: per-endpoint map in localStorage replacing the single
  `BRIDGE_TOKEN_COOKIE` slot. The cookie handshake only works for the
  own-origin server; added servers authenticate by `?token=` / bearer only.
- `CrystalProvider` builds a **store bundle per connected server** (the same
  eleven stores, constructed against that server's client), resolved through
  context by the active `(server, ws)`. Per-workspace views keep calling
  `useCrystal()` unchanged. Cross-project stores change key: `runsByWs` etc.
  become keyed by `"<serverId>/<wsId>"`; `seenAtByWs` (localStorage
  `crystal.seenRuns`) migrates to the compound key; terminal tabs already
  carry `ws` and gain `sid`.
- Nav/deep links: `ws` param becomes `sid:wsId` when the target isn't the
  default server (bare `wsId` stays valid — backward compatible; `wsId` is a
  path hash, so it's stable per machine but *not* unique across servers
  hosting the same root, hence the prefix).
- Workspace tabs list every workspace of every connected server, grouped by
  server when more than one; the `+` menu grows a "Connect to bridge…" entry.

### C3. Known cross-server collisions (flagged, not solved here)

- **Hub**: `~/.crystal/hub/programs` is shared by all servers on one machine —
  two local servers see the same programs (harmless today, single hub engine
  per server writes them; racy if both run managers). Fleet v1 renders Hub
  per-server. The portfolio one-live-delivery-per-project lock is also
  per-server. Both get real answers in the account layer, where hub state
  moves behind one owner.
- **Cross-machine wsId collisions** (same path on two machines) only matter
  once the account layer syncs anything keyed by wsId; the `sid:` prefix
  already disambiguates everything the client holds.

---

## Build order

1. **A** profiles: schema + storage + `resolveProfile` + `agent:` tag (server) →
   spawn plumbing → WorkerSpec/prompts → Agents-tab roster UI.
2. **B** run surface: `chainOf` + ChainTurns + MessageComposer + `agent.message` →
   `RunSurface` + per-file diff → adopt in orchestrator/hub/workflow →
   RunList `ws` column + Jobs fold → delete duplicates.
3. **C** fleet: C1 server hygiene (independent, can ship during A/B) →
   BridgeClient fixes → FleetClient + per-server store bundles → compound
   keys in cross-project stores → tabs/deep links.

Quick wins that can land any time: the BridgeClient close/retry fix, the
formatter dedup, the Discard confirm.

The ends plug in afterward without rework: the attention queue is a projection
over fleet-store's compound-keyed maps rendered with the `ws`-badged RunList;
review verbs are actions on RunSurface's Changes pane feeding
`agent.message`/`deliver`; capture files todos through the same bridge the
fleet client already reaches.

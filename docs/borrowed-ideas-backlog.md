# Borrowed-ideas backlog

Findings from analyzing **operator-oss** (github.com/iishyfishyy/operator-oss — a
local cockpit for parallel Claude Code/Codex sessions, one worktree per task) and
**qm** (github.com/yc-software/qm — a multi-tenant org agent runtime: Postgres-durable
runs, vendor-agnostic harness layer, crons/watches, budgets).

**Implemented in Crystal (2026-08-02):** worktree merge-back with `merge-tree`
prediction + agent conflict resolution; recoverable-failure classification
(context overflow / usage limit / auth) with recovery affordances; session
lineage handoff (`agent.handoff` — summarize → fresh session, same worktree);
structured questions with server-side answer delivery through the resume chain
(no more client-side session forking) + the "needs you" surface; the Insights
tab (client-computed spend/tokens/runs by day, model, purpose).

The rest, in rough priority order. Source pointers reference the analyzed repos.

## 1. Managed-services supervisor (operator-oss `lib/services.ts`)

> Done 2026-08-02: `apps/server/src/service-manager.ts` + `.crystal/services.json`
> (new "services" file kind) + `service.*` bridge methods/events + the jobs-hub
> Services section (start/stop/restart, log ring tail, port pre-probe,
> desired-state restore with ps-guarded orphan reaping). Surfaces previews now
> prefer running services' ports over package.json guesses
> (`ServiceManager.demoTargets` overlay in the `surfaces.get` handler).
> Remaining from the original list: per-repo deterministic ports.

The original notes, for the remaining bits:

- Detached **process-group** children owned by the server — they survive
  run-end and browser-close. State write-through to disk so
  `desired_state=running` services restart with the server.
- **Orphan reaping** after a hard crash: persist the group-leader pid, and on
  boot reap the group *only after* a `ps -o pgid=,command=` membership check
  guards against pid reuse.
- **Port pre-probe** (bind exclusively, then poll a grace window) turns
  EADDRINUSE crash-loops into a readable error. SIGTERM → SIGKILL-at-4s on the
  negative pid kills the whole shell→npm→node tree.
- Bounded in-memory log ring (~1500 lines), streamed over the bridge.

Crystal fit: surfaces mode's live screen/Storybook previews currently assume
the user hand-runs dev servers; this makes them one-click and gives the jobs
hub a "services" category. Composes with watches (below). The per-repo
deterministic port idea also fixes preview-URL guessing.

## 2. Watches — wake an agent on a background event (qm `src/monitors/`)

> Done 2026-08-02 for managed services: `WatchDef` in core service.ts (literal
> alternatives + anchors, never regex), supervision inside ServiceManager
> (log-match + on-crash fires, min-interval throttle), registry wiring
> dispatches a `fix`-purpose run tagged `watch:<id>` with one live run per
> watch, UI in the Services section. Remaining: watches over quality runs and
> agent runs (not just services).

## 3. Per-run pending-message queue + atomic turn slot (operator-oss `lib/abort.ts`)

> Partially done 2026-08-02: `agent.message` + the RunView composer deliver
> user steering into any run's chain (resumed / queued / recorded). Remaining:
> the atomic-claim hardening below.

The concurrency details worth copying exactly:

- ~~Session fork guard~~ — done 2026-08-02: `agent.start` refuses
  `resumeSessionId` while any run of that session is live (synchronous check;
  resumed runs carry their session id from creation so back-to-back resumes
  are covered).
- `handoffTurn` atomically swaps the finishing turn's slot to the dequeued
  follow-up so occupancy never lapses (Crystal's flushNotices re-checks
  liveness instead — adequate while resumeChain serializes per chain root).
- Per-task FIFO lock couples turn launch to git mutations; merges re-check
  liveness inside the lock (Crystal's merge ops refuse on a live worktree
  sharer — the remaining gap is coupling that check to run *launch*).
- Transcript heal (qm) is effectively covered: session ids persist, so a
  server-killed run's chain is resumable via the run composer
  (`agent.message`) — the CLI owns its own session-file consistency.

Crystal fit: `resumeChain` already serializes per chain root; the remaining gap
is a user-facing "message this run" composer (the workflow manager has one;
plain runs don't) and lock coupling between run launch and the new merge ops.

## 4. Spawn hygiene (both projects)

- **Billing safety** (operator): ~~strip `ANTHROPIC_API_KEY`~~ — done
  2026-08-02 (`claudeSpawnEnv` in agent-manager.ts, opt-out via
  `CRYSTAL_ALLOW_API_KEY=1`).
- **Config jail** (qm `claude-harness.ts`): the safe, high-value part is done
  2026-08-02 — every scoped run (manager/task-bound, i.e. anything with an
  `--mcp-config`) now passes `--strict-mcp-config`, so the user's global/project
  MCP servers can't bleed into Crystal's scoped runs (confirmed with
  claude-code-guide: it scopes MCP only, leaving login/hooks/settings active).
  The rest of the qm jail (`CLAUDE_CONFIG_DIR`, disabling user hooks/settings)
  is deliberately NOT done: Crystal is single-user local, where the user's own
  hooks/settings running is the expected behavior, and jailing them risks
  breaking the user's real workflow while hiding the login. Revisit only if
  Crystal ever runs untrusted multi-tenant agent sessions.

## 5. Agent-driver seam + capabilities-as-data (both projects, convergent)

One interface (`runTurn(...): AsyncGenerator<StreamEvent>` + optional one-shot
helpers) per agent vendor, a registry, and an `AgentCapabilities` descriptor
(models + context windows, permission modes, `supportsResume`,
`reportsCostUsd`, `costIsEstimated`, login style) that the UI renders from —
no hardcoded per-agent knowledge anywhere. qm adds mid-session switching
(`resetSession` on both adapters) and "utility jobs" (summarize/judge/title)
with a connected-first fallback agent.

Crystal fit: `AgentEvent` is already the normalized stream contract; the
refactor is extracting Claude-CLI-specifics from `agent-manager.ts` behind an
interface. Only worth it when a second agent (Codex) is actually wanted; brings
operator's estimated-cost pricing (longest-prefix model match, cached-rate
discount, `~` marker) along.

## 6. Cron / standing tasks (qm `src/cron/`)

> Done 2026-08-02: `packages/core/src/standing-task.ts` (interval/daily
> schedules, `nextFireAt` with missed-slot catch-up, fresh-session fire
> preamble) + `apps/server/src/standing-tasks.ts` (minute sweeper, one live
> fire per task, restart-safe `lastFiredAt`, fires tagged `standing:<id>` so
> the run list IS the fire log) + `.crystal/standing-tasks.json` ("standing"
> file kind) + `standing.*` bridge methods + the jobs-hub section. Single
> instance, so qm's atomic slot claiming wasn't needed.

## 7. Security screening of tool results (qm `src/security/`)

A provenance-labelled LLM classifier screens external/tool-result content
before it reaches the agent (`sender` = trusted human, `tool_result:<name>` =
judge only for embedded instructions), three postures (`dangerous < auto <
strict`) where scopes can only tighten the org floor, **shadow mode** to
evaluate the classifier before enforcing, fail-closed on timeout. Real per-turn
cost/latency — a product decision, not a drop-in.

## Security follow-up (from the 2026-08-02 review)

- **Standing tasks auto-fire on open — FIXED 2026-08-02.** As first written, a
  repo-controlled `.crystal/standing-tasks.json` with a due task auto-fired a
  code-exec-capable agent (dev-loop allowlist: `Bash(node *)` etc.) purely from
  opening the workspace — no click. Fixed with a trust-gate floor
  (`StandingTaskEngine.sealFloors` + the persisted `notBefore` map): a
  never-fired task never fires retroactively, so its first fire is always a
  genuine future scheduled slot; only tasks with a real fire history catch up
  on missed slots after a restart. Explicit "fire now" (a user action) still
  fires immediately. Pinned by the "trust gate" test. Everything else in the
  batch reviewed clean (git via execFile/argv — no injection; `resolveInRoot`
  guards service cwd; watch patterns are literal; `shell:true` service spawn is
  same-trust as the pre-existing terminal/agent bridge methods and needs a user
  start).

## Correctness follow-up (from the 2026-08-02 review)

Three parallel bug-hunt agents over the riskiest new logic (git merge
orchestration, scheduling, agent concurrency). Two confirmed bugs found and
**fixed the same day**:

- `ServiceManager.saveDefs` orphaned a service stuck in `"starting"` (mid
  port-probe) — the retention guard only excluded `"running"`. Now excludes
  both. Pinned by a "saved away while running" test.
- `StandingTaskEngine.fire` had a double-fire window (two concurrent
  `fireNow`, or `fireNow` racing the sweep, both passed the not-yet-registered
  `liveRunId` check). Added a synchronous per-task `firing` claim before any
  await. Pinned by a "two concurrent fires" test.

Also hardened: `handoff()` re-checks `chainLive` after the summarizer settles
(a worker-notice resume could otherwise briefly fork the session — narrow,
was ~55% confidence). The merge engine and the rest of agent-manager reviewed
clean. Noted: the object-level no-checkout merge needs git ≥ 2.40 for
`merge-tree --name-only` (degrades safely to "prediction unavailable" on
older git; error message corrected).

## 8. Smaller notes

- **killTree consolidation** — done 2026-08-02: shared
  `apps/server/src/process-tree.ts` (`killProcessTree`: Windows taskkill /T,
  POSIX pid-or-group signal + optional SIGKILL escalation); service-manager,
  quality-runner and agent-manager migrated. terminal-manager keeps its own
  (node-pty owns that handle).

- **Recap sweep** — done 2026-08-02, derived instead of LLM-generated:
  `buildWorkspaceRecap` (core recap.ts) headlines the newest run + rolls up
  24h spend/failures on each overview workspace card.
- **Auth-broken instance flag** — done 2026-08-02: `AgentManager.trackAuthHealth`
  (auth failure raises, any success clears + flushes parked chains),
  `agent.authChanged` event, `agent.list` carries the flag, banner in
  orchestrate mode.
- **Transcript heal on restart** (qm `tape-fold.ts`): when the server dies
  mid-turn, orphaned tool calls get an `INTERRUPTED_TOOL_RESULT` placeholder so
  the persisted transcript stays well-formed for resume. Crystal marks such
  runs failed; healing would make them resumable instead.
- **Cross-workspace "needs you"**: the new signal is per-workspace (client
  derives it from the active workspace's stores). Aggregating across open
  workspaces needs a server-side rollup or fleet-store extension.
- **boot-id orphan detection** (qm `exec-process-session.ts`): persist
  `/proc/sys/kernel/random/boot_id` (or platform equivalent) with background
  jobs; on restart, a differing boot id means "exited by reboot", not "still
  running". Relevant to the jobs hub if jobs ever persist across restarts.

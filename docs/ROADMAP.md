# Crystal roadmap — informed by the appliance.sh dogfood

*2026-07-14. Everything in this document is grounded in one exercise: pointing Crystal
at [appliance.sh](https://github.com/appliance-sh/appliance.sh) — a real 12-package
monorepo (Express control plane, Vite + react-router console, Tauri desktop, Rust
microVM, CLI, Pulumi infra) — and comparing what Crystal reported against what is
actually true of that codebase.*

## The thesis

Crystal's product is **trust in derived understanding**. An IDE that draws the
architecture, lists the API surface, and flags dead code is only as valuable as the
user's confidence that those views are true. The dogfood run showed how one resolver
gap can cascade: a single unresolved tsconfig alias severed appliance's entire
frontend from the import graph, which produced ~50 false dead-file findings, an empty
frontend→backend trace, and inflated unused-export counts — all while the genuinely
correct findings (a real abandoned service layer) sat in the same list, indistinguishable.
A user who catches one false "your live app is dead" stops believing everything else.

So the roadmap orders work by **credibility leverage**: resolver correctness first,
then honest presentation of uncertainty, then the ambitious product surfaces.

---

## Shipped (2026-07-28 — the three-diagram consolidation)

*Five separately-grown diagram mechanisms (systems overview, editable diagrams
canvas, infra view, code map, surfaces system map) collapsed into three
standardized views — `architecture` / `codebase` / `infra` — with one diff
vocabulary, one vs-ref review, one selection/facet story. Ten commits, each
verified against a live bridge + Playwright.*

| Capability | Where |
| --- | --- |
| **One canonical architecture**: derived from `codemap.overview` + detected external services (stable ids `sys:`/`ext:<svc>[:<instance>]`/`link:`/`screen:`/`flow:`), composed with a persisted user overlay; canvas edits round-trip through `extractOverlay` (only real drags pin positions; auto-layout at reserved LOD footprints owns the rest); legacy diagrams + systems-layout migrate losslessly ONCE on first read, each old diagram becoming a facet with `sourcePath` | `core/arch-derive.ts`, `core/arch-overlay.ts`, `core/arch-migrate.ts`, `ArchitectMode.tsx` |
| **One vs-ref review on all three views**: `codemap.snapshotAtRef` (cheap in-memory overview path vs full-analyzer materialization, LRU per commit, statused changed files riding along) + client `useRefReview` + shared `DiffMarks`/ghost vocabulary; codebase map gains file-level diff with ghost deletions; architecture gains marks/ghosts + a categorized entry panel; infra tints placed drift. Replaces `codemap.overviewDiff` (still feeding the legacy systems tab), `surfaces.atRef` (deleted) and `archdraft.fromRef` (deleted) | `core/diagram-diff.ts`, `core/code-map-diff.ts`, `client/ref-review.ts`, `panels/DiffPanel.tsx` |
| **Named service instances**: literal bucket/queue/topic/table names extracted at parse time (gated on the file importing that service's client) become distinct `ext:` nodes — every queue and bucket a different box | `core/external-services.ts` (`extractServiceInstances`), `server/code-map.ts`, `core/arch-derive.ts` |
| **Surfaces map folded in**: screens render as grouped frontend nodes with screen→system flow edges (`layers=screens`); `#/surfaces/map` is a permanent parse redirect (`ep:` selections → API explorer); SystemMapView/worker/diff deleted; surfaces defaults to Screens | `core/arch-derive.ts`, `deeplink.ts`, `SurfacesMode.tsx` |
| **Contracts + Insights on the unified canvas**: the boundary inspector and cycles/violations/hubs/orphans as panels with canvas focus; same deep-link params the systems overview used | `panels/ContractsPanel.tsx`, `panels/InsightsPanel.tsx` |
| Consolidated ids with permanent aliases (`diagrams`→`architecture`, `codemap`→`codebase`), `vs`/`layers` params, the dups/findings/changes encoding gap closed, bare-codemap-boot bug fixed, find wired on the codebase map | `deeplink.ts`, `CodeMapView.tsx` |

Completed in the same pass: role chips + focus filter on the unified canvas
(view filters re-inject before `extractOverlay`, same rule as review
ghosts), and the legacy `systems` tab fully retired — `SystemsView` deleted,
`systems` a permanent parse alias (`?system=` settles into `sel`), the
surfaces arch side pane embeds the live canonical canvas (`ArchPane` over
the shared `useCanonicalArchitecture` hook), and `codemap.overviewDiff` +
`syslayout.*` left the bridge. The architect mode is exactly the three
views.

## Shipped (this pass)

Fixed and verified against appliance — dead files went **74 → 5** (all five real),
endpoints went from unmounted fragments (`GET /:id`) to the true API surface
(`GET /api/v1/deployments/:id`), and Quality went from "No test setup detected" to
running per-package vitest.

| Fix | Where |
| --- | --- |
| tsconfig `paths` alias resolution (`@/…`), extends-chain + baseUrl aware, live analyzer **and** git-ref snapshots | `apps/server/src/ts-paths.ts`, `code-map.ts`, `ref-snapshot.ts` |
| Monorepo test detection: per-package runner discovery, file-scoped runs route to the owning package, unscoped runs fan out across packages sequentially, coverage merges every package's istanbul output | `apps/server/src/quality-runner.ts`, `packages/core/src/quality.ts` |
| Express router-mount composition (`app.use("/api/v1/keys", …)`) — transitive, cycle-safe; endpoint paths are real URLs in surfaces, the systems overview, and ref diffs | `code-map.ts` (mount parse), `surfaces-report.ts` (`computeMountPrefixes`) |
| Spec files no longer contribute endpoints to the API surface | `surfaces-report.ts` |
| Next.js conventions gated on the owning package actually using next; Vite + react-router `pages/` dirs no longer mislabeled | `surfaces-report.ts` |
| react-router route tables declared as `const routes: RouteObject[] = […]` are extracted (not just inline factory calls) | `surfaces-report.ts` |
| Dead-file entry-point awareness: package.json `bin`/`main`/`exports`/script-referenced files (with dist→src mapping back to sources), config files, `bin/`·`scripts/` dirs, `src/main.*`, entrypoints, node `server.js` conventions | `code-map.ts` (`declaredEntryPaths`, convention rules) |
| Deep-link hardening: intuitive aliases (`#/overview`, `#/editor`, `#/coverage`, `#/apis`…) resolve to real modes/subviews; unknown hashes fall back to the default view and normalize the URL instead of silently no-opping | `packages/core/src/deeplink.ts`, `packages/sdk/src/deeplinks.ts` |
| Test-mirror lint: a duplicate cluster spanning test + production code reads "a test re-implements X instead of importing it" (no hoist suggested — the fix is importing) | `packages/core/src/code-review.ts` |
| Frontend→backend tracing through API-client objects: `client!.listDeployments()` resolves to the unique class declaring the method; `this.request("GET", "/path")` helper calls extract as API calls; apiTrace narrows a class step to the methods the page actually invoked. Appliance's DeploymentsPage now traces to `GET /api/v1/deployments` in `deployments/index.ts` | `code-map.ts` (collectCalls, buildCallGraph, apiTrace) |
| Generic structural names (`utils`, `lib`, `helpers`, `common`…) no longer merge across packages in the systems overview and carry their owner ("Cli utils", "Infra lib") instead of anonymous "Utils" boxes | `packages/core/src/system-overview.ts` |

Also fixed en route: the web app on main did not boot (workspace links for the new
surfaces/quality modes were never installed — `pnpm install` was missing).

## Shipped (2026-07-16 — the inventor dogfood)

*Second real-codebase pass: [inventor](~/Workspaces/inventor), a single-package
Vite + Tauri parametric CAD app — no git, no router, no backend, WASM geometry
kernel, being actively edited by an agent mid-analysis. Almost the perfect inverse
of appliance, and it exposed exactly the monorepo/web assumptions you'd expect.*

| Fix / tool | Where |
| --- | --- |
| Directory-level code map modules for single-package workspaces: with one package.json the map degenerated to a single "." node (no deps, no crossings, journeys never spanned modules); top-level source dirs (`src/core`, `src/export`, `scripts`…) now become modules, in the live analyzer and git-ref snapshots alike. Monorepos keep exactly their packages. Inventor: 1 module/0 deps → 11 modules/28 weighted edges | `code-map.ts` (`synthesizeDirModules`), `ref-snapshot.ts` |
| **Recent-changes review without a VCS** (`codemap.changes` + "changes" panel in the architect code views): files touched inside a window from timestamps, added-vs-modified via birthtime (with an importer-age corroboration against atomic-rewrite noise), per-module rollups with tests-touched flags, blast radius (importers outside the changed set), and "unwired" flags on additions nothing imports yet | `code-map.ts` (`changes`), `packages/architect/src/codemap/ChangesPanel.tsx`, deeplink `?changes=1` |
| Non-git workspaces are a state, not an error: `git.status` reports `isRepo: false` instead of a raw command failure | `apps/server/src/git.ts`, `bridge.ts` |
| Plain-library visibility: the externals story was services-only (DBs, queues, SaaS), so a client app showed nothing external at all; the heaviest plain npm libraries now surface per workspace (`CodeMapSummary.libraries`) and per system ("Geometry leans on manifold-3d, three") | `packages/core/src/external-services.ts` (`aggregateExternalLibraries`), `system-overview.ts`, `SystemsView.tsx` |
| Intent corroboration: a single repeated lexicon stem no longer asserts an intent — inventor's expression *tokenizer* was tagged `intent:auth` ("token"/"tokens"). An intent now needs two distinct word stems, symbolic/agent support, or the unit's own name | `code-index.ts` (evidence per hit, `evidenceStem`), `system-overview.ts` (profile pruning) |
| Client-only layer inference: a Tauri/browser app with no endpoints, no server-framework imports and no server-ish paths no longer labels its solver/kernel systems "backend" — everything ships in the client bundle and lands in the frontend lane | `system-overview.ts` |

Regression standard held: appliance still reports dead-files = 5, endpoints under
`/api/v1`, quality packages = 8, modules = its packages exactly.

Observed but not yet addressed (adds to Next): `#/architect/codemap` deep links are
clobbered back to the diagrams view by the workspace-level unification effect —
links with `?at=module` work, bare codemap links don't survive boot.

## Shipped (2026-07-16 — orchestration layer)

*A generic multi-agent orchestration layer over the existing PM board + agent
runs, replacing what previously required a hand-pasted "manager kickoff" prompt
and an external Notion board.*

| Capability | Where |
| --- | --- |
| **Lease ownership / borrow checker**: exclusive per-task write leases with TTL + heartbeat; every task mutation must present the lease's capability token (`claimId`); stale leases from crashed agents heal on the next claim; the human owner has an explicit `force` override. Leases and costs are **server-owned columns** — whole-project saves from a (possibly stale) UI snapshot cannot clobber them | `packages/core/src/orchestration.ts` (rules), `apps/server/src/orchestration.ts` (enforcement, serialized per-workspace mutation queue) |
| **Epics & issues**: `blockedBy` task dependencies with `readyTasks` ordering (priority-first), board-level ready/blocked surfacing | `packages/core/src/project.ts`, orchestrator Board (blocked badge) |
| **Cost attribution**: per-run usage (already metered per assistant turn) is priced per model (`MODEL_PRICING`, cache reads/writes billed at their real rates, CLI-reported cost preferred) and folded into durable rollups on tasks and epics when runs settle — run history is ephemeral, the board keeps the bill. Board cards fall back to the durable rollup when runs age out | `orchestration.ts` (`rollupCost`, `sumCostRollups`), `workspace-registry.ts` (settle hook), Board/TaskDetail |
| **Delegation**: manager runs get board tools over the in-process MCP endpoint — `board_status`, `create_epic`, `create_task`, `claim_task`, `update_task`, `release_task` — alongside `dispatch_worker`, which now takes a `taskId` so each worker bills the right task. Claim ids are capabilities: handed only to the claimant, never listed in snapshots | `apps/server/src/mcp/dispatch-mcp.ts`, `mcp/http.ts`, `agent.ts` (WorkerSpec.taskId) |
| Bridge methods for the same flow (`task.claim` / `task.release` / `task.update`), lease chip + owner force-release in the orchestrator UI, and a rewritten manager-mode preamble teaching the loop (board-first, claim-before-write, review dispatch, escalate only at forks) | `bridge.ts`, `server.ts`, orchestrator `Board.tsx` / `TaskDetail.tsx` / `AgentsTab.tsx` |

## Next (highest credibility leverage)

1. **API tracing, phase 2.** Instance dispatch now resolves when a method name is
   unique across the workspace's classes; the remaining gaps are namespaced client
   shapes (`client.deployments.list()` — nested receivers with generic method
   names), object-literal API modules, and per-instance disambiguation when two
   classes share a method name. Deliberately **not** approximated via import-closure
   — showing every fetch in the sdk as "reachable" from every page would be
   plausible and wrong, the exact failure mode this roadmap exists to avoid.
2. **Confidence and provenance on findings.** Every finding should carry *why Crystal
   believes it* ("no importer found among 270 analyzed files; entry-point rules
   checked: bin, exports, configs") and one click to falsify it (the would-be
   importers view). False positives will never be zero; being auditable is what keeps
   trust when one slips through.
3. **CI smoke for the shell.** Boot Vite, lazy-load every registered mode, fail on
   console errors. The broken main (unresolvable `@crystal/surfaces`) would have been
   caught by the cheapest possible harness.
4. **Polyglot modules.** The map of a microVM product currently does not contain the
   VM: `packages/vm` (Rust) and `src-tauri` are invisible. Even opaque module nodes
   derived from `Cargo.toml` (name, dep edges from `[dependencies]`, file count)
   would complete boundary pictures and make desktop↔VM seams visible.
5. **Domain clustering, phase 2.** "Cli utils" beats "Utils", but appliance's real
   domains — deployments, environments, bootstrap, agents, keys — are recoverable
   from route prefixes (`/api/v1/deployments/*`), schema names, and directory nouns.
   The overview should cluster by product domain first and structure second, so it
   reads like the product, not the filesystem.

## Horizon (product bets the dogfood validated)

- **Doc-drift as a first-class insight.** Appliance's ARCHITECTURE.md declares three
  dependency edges; the derived graph has thirteen. Diffing *declared* architecture
  (docs, or Crystal's own contracts) against *derived* reality is cheap here and rots
  in every real repo — a "your docs say X, the code says Y" panel is a distinctive,
  recurring-value feature.
- **Runs-on-a-real-repo test bed.** The five remaining appliance dead files are all
  genuinely dead — that's the standard. Keep appliance (or a pinned fixture like it)
  as a regression bed: every codemap/surfaces/quality change re-runs against it via
  the verify skill before merging. Synthetic fixtures don't have `@/` aliases, 8.3
  path weirdness, sidecar mains, or half-abandoned service layers; real repos do.
- **Empty states that convert.** The Quality empty state honestly explained what
  Crystal looks for — good — while a "Tests 43" badge sat in the same header —
  contradictory. Every empty state should reconcile with what detection *did* find
  and offer the action that closes the gap ("46 test files in 8 packages — run them").
- **Canvas density.** The systems view renders one tall stack with most of the
  viewport empty and a third of the systems below the fold. Auto-fit on load, denser
  group packing, and a "N systems hidden" affordance would make the first-open moment
  land.

## Known limitations (stated, not hidden)

- API tracing crosses object-method dispatch only via unique method names; nested
  receivers (`client.deployments.list()`) and shared method names stay unresolved
  (see Next #1).
- Rust/polyglot code is invisible to the code map (Next #4).
- `install-aws`'s CDK stack classes are flagged dead; they may be referenced by
  CDK synthesis conventions Crystal doesn't model. Judged acceptable — the package
  is documented as a placeholder — but it's the kind of case provenance (Next #2)
  should let a user adjudicate in one click.

# Changelog

## v0.38.0 (2026-08-22)

### Features

- user-asserted cross-project service identity links ([`2183dff`](https://github.com/lab255/Crystal/commit/2183dff))

## v0.37.2 (2026-08-22)

### Bug Fixes

- contain ELK layer-constraint crashes, surface compose diagnostics ([`d4ff776`](https://github.com/lab255/Crystal/commit/d4ff776))

## v0.37.1 (2026-08-22)

### Bug Fixes

- dogfood findings — ELK band crash containment, viewer overlay writes, empty targets ([`6eb68b1`](https://github.com/lab255/Crystal/commit/6eb68b1))

## v0.37.0 (2026-08-22)

### Features

- mount compose suggestions band on the Deployment canvas ([`fbd186f`](https://github.com/lab255/Crystal/commit/fbd186f))
- docker-compose detection with suggested deployment topology ([`45a8ebb`](https://github.com/lab255/Crystal/commit/45a8ebb))
- deployment context menus, environment-scoped notes, guarded delete routing ([`93a38fd`](https://github.com/lab255/Crystal/commit/93a38fd))

### Bug Fixes

- arch overlay saves update the runtime read memo ([`84b544d`](https://github.com/lab255/Crystal/commit/84b544d))

## v0.36.0 (2026-08-22)

### Features

- ELK-based deployment target layout with occupied-slab free space ([`cf0a697`](https://github.com/lab255/Crystal/commit/cf0a697))

### Bug Fixes

- make elkjs actually run inside the layout workers ([`8614712`](https://github.com/lab255/Crystal/commit/8614712))

### Performance

- architecture ELK solve moves to a lazy module worker ([`c9b336e`](https://github.com/lab255/Crystal/commit/c9b336e))
- permutation-independent layout inputs for dagre paths ([`c71c614`](https://github.com/lab255/Crystal/commit/c71c614))

## v0.35.0 (2026-08-22)

### Features

- wire cross-project infra scope, zone-safe canvas commits, Overview entry ([`185ed57`](https://github.com/lab255/Crystal/commit/185ed57))
- typed-target Deployment view, env-scoped zones, adoptable externals, C4Deployment export ([`9c3564c`](https://github.com/lab255/Crystal/commit/9c3564c))
- cross-project infra projection, hub overlay store, event translation ([`22c9774`](https://github.com/lab255/Crystal/commit/22c9774))
- cross-project infrastructure scene + client store ([`0ec6d93`](https://github.com/lab255/Crystal/commit/0ec6d93))
- typed deployment targets, env-scoped zones, cross-infra bridge contract ([`1f71bce`](https://github.com/lab255/Crystal/commit/1f71bce))

## v0.34.0 (2026-08-22)

### Features

- codemap exclusion summary + importedBy cap seams ([`e61d5df`](https://github.com/lab255/Crystal/commit/e61d5df))

### Bug Fixes

- collapsed modules stop reserving fully-expanded layout slots ([`204d492`](https://github.com/lab255/Crystal/commit/204d492))

### Performance

- exclude generated code from the code map analyzer ([`bc91ed1`](https://github.com/lab255/Crystal/commit/bc91ed1))
- code map rebuild batching, scene caps, O(N^2) hot-spot fixes ([`f434ffb`](https://github.com/lab255/Crystal/commit/f434ffb))
- worker-memo restarts on stall instead of freezing the main thread ([`580ca89`](https://github.com/lab255/Crystal/commit/580ca89))

## v0.33.0 (2026-08-19)

### Features

- replace orchestrator/hub UI with chat-first threads mode ([`1246bc5`](https://github.com/lab255/Crystal/commit/1246bc5))

## v0.32.0 (2026-08-18)

### Features

- palette session jumps, rail/live elapsed, resumable hints ([`38fde0c`](https://github.com/lab255/Crystal/commit/38fde0c))
- DX-journey fixes — every open-run jump lands on Sessions ([`b49afb4`](https://github.com/lab255/Crystal/commit/b49afb4))
- headless sessions can go interactive; one working predicate; calmer rail ([`c829bbc`](https://github.com/lab255/Crystal/commit/c829bbc))
- adopt sessionHeadline everywhere ([`3062e25`](https://github.com/lab255/Crystal/commit/3062e25))
- cross-workspace live-runs lane on the Overview ([`1626916`](https://github.com/lab255/Crystal/commit/1626916))
- sessionHeadline — the one session naming derivation ([`0416178`](https://github.com/lab255/Crystal/commit/0416178))
- needs-you dots in the Runs tab list ([`a5f25c6`](https://github.com/lab255/Crystal/commit/a5f25c6))
- bb-style hierarchical sessions rail ([`db7e6a9`](https://github.com/lab255/Crystal/commit/db7e6a9))
- parentage-derived worker hierarchy in WorkflowsTab ([`df8f2cf`](https://github.com/lab255/Crystal/commit/df8f2cf))
- recursive RunList tree, unified status, AgentsTab roster/run split ([`cf2e15e`](https://github.com/lab255/Crystal/commit/cf2e15e))
- shared session-tree display seams for the hierarchical agents UI ([`64e3efb`](https://github.com/lab255/Crystal/commit/64e3efb))
- SessionsTab — grouped rail, live console, spawn + resume ([`acb51f7`](https://github.com/lab255/Crystal/commit/acb51f7))
- sessions rail — SessionGroupList, spawn helper, empty groups ([`3004208`](https://github.com/lab255/Crystal/commit/3004208))
- session grouping, sessions deep links, interactive resume ([`29a0a91`](https://github.com/lab255/Crystal/commit/29a0a91))
- boot to the workspace picker instead of forcing a root ([`0e1858f`](https://github.com/lab255/Crystal/commit/0e1858f))

### Bug Fixes

- name the orphaned-terminal dead end instead of connecting forever ([`1760faf`](https://github.com/lab255/Crystal/commit/1760faf))
- badge interactive agent PTY tabs with the agent icon ([`8f8d37f`](https://github.com/lab255/Crystal/commit/8f8d37f))
- embedded run consoles no longer steal keyboard focus on mount ([`579a777`](https://github.com/lab255/Crystal/commit/579a777))
- title sessions by their opening prompt; Sessions in palette ([`dafed00`](https://github.com/lab255/Crystal/commit/dafed00))
- gate Resume on non-cancelled chains, retry terminal probe, scope-aware draft ([`39ef9c5`](https://github.com/lab255/Crystal/commit/39ef9c5))
- confine interactive cwd, gate worktree re-entry behind trustedCwd ([`7d64a7b`](https://github.com/lab255/Crystal/commit/7d64a7b))
- style merge/apply failure notes loudly, not as success text ([`dbdbeaa`](https://github.com/lab255/Crystal/commit/dbdbeaa))
- publishConfig.access public, trim published files to dist only ([`4f26e88`](https://github.com/lab255/Crystal/commit/4f26e88))
- bundle @crystal/* workspace deps for standalone npm publish ([`12a0ec7`](https://github.com/lab255/Crystal/commit/12a0ec7))

## v0.31.1 (2026-08-10)

### Bug Fixes

- stop boot-time CLI open from clobbering the persisted open set ([`830b65f`](https://github.com/lab255/Crystal/commit/830b65f))

## v0.31.0 (2026-08-10)

### Features

- session, blocked-by, question-count and cost chips ([`28d2270`](https://github.com/lab255/Crystal/commit/28d2270))
- stale-aware attention counts + inbox dismiss surfaces ([`34f466a`](https://github.com/lab255/Crystal/commit/34f466a))
- hub answer path — id tokens, trusted context, exact attribution, typed failures ([`a48fdb4`](https://github.com/lab255/Crystal/commit/a48fdb4))
- run worktree sync tiers + create/update PR with per-worktree op mutex ([`1719177`](https://github.com/lab255/Crystal/commit/1719177))
- typed question lifecycle — origin attribution, closure verbs, evidence-based expiry, deliverability ([`3445fea`](https://github.com/lab255/Crystal/commit/3445fea))

## v0.30.0 (2026-08-09)

### Features

- safe-mode workspace restore behind a crash sentinel ([`9cad86d`](https://github.com/lab255/Crystal/commit/9cad86d))

## v0.29.0 (2026-08-09)

### Features

- permissions and allow improvements ([`7b111d0`](https://github.com/lab255/Crystal/commit/7b111d0))

## v0.28.0 (2026-08-08)

### Features

- typed steer receipts on all routes, fleet permission counts, browse errors, turn deep-links, composer-compliant console ([`2851094`](https://github.com/lab255/Crystal/commit/2851094))

## v0.27.0 (2026-08-08)

### Features

- diagram export — fitted 2x PNG everywhere, mermaid C4 download/copy ([`d8fa403`](https://github.com/lab255/Crystal/commit/d8fa403))
- textual diffs end-to-end — Monaco DiffView, walkable changed files, base-branch preset, direction toggle ([`3258cf0`](https://github.com/lab255/Crystal/commit/3258cf0))
- package-scoped run picker + live job progress; test(relay): envelope lockstep with core publish.ts ([`40d6f44`](https://github.com/lab255/Crystal/commit/40d6f44))
- capability palette, shortcut cheat-sheet, status legends, public copy-links, unknown-link notices ([`9d6acdb`](https://github.com/lab255/Crystal/commit/9d6acdb))
- independent loads, truthful coverage + previews, walkable reruns, labeled affordances ([`cfd28b8`](https://github.com/lab255/Crystal/commit/cfd28b8))
- package-scoped runs, streamed progress, coverage diagnostics, collision-safe test names ([`04c3548`](https://github.com/lab255/Crystal/commit/04c3548))
- human surfaces for permissions, budgets, deliveries, dead chains ([`fae2c8a`](https://github.com/lab255/Crystal/commit/fae2c8a))
- canvas edit safety + hidden/stale recovery + honest panels ([`a77e51d`](https://github.com/lab255/Crystal/commit/a77e51d))
- unsaved-work safety net — dirty-close confirms, conflict-guarded saves, read-only truncated files, external-change refresh ([`52fbd8a`](https://github.com/lab255/Crystal/commit/52fbd8a))
- conflict-guarded fs.write, git.showFile, typed agent.message outcome, arch.overlayChanged event ([`ebe366c`](https://github.com/lab255/Crystal/commit/ebe366c))

### Bug Fixes

- refit on node-set swaps so onlyRenderVisibleElements can't cull a fresh scene to a blank map ([`2494c56`](https://github.com/lab255/Crystal/commit/2494c56))
- hub/infra hardening — bearer-gated TCP MCP, per-project dispatch lock, atomic records, honest publish errors, safe orphan reap ([`7b9145d`](https://github.com/lab255/Crystal/commit/7b9145d))
- orchestration race fixes — close-gated settlement, durable steering, serialized compaction, guarded dispatch, handoff forwarding ([`b13d53c`](https://github.com/lab255/Crystal/commit/b13d53c))
- scope-epoch guards, durable failed saves, overlay refetch on remote change, prompt close rejection ([`043f7f5`](https://github.com/lab255/Crystal/commit/043f7f5))
- review-driven rule fixes — dup-dep cycles, unique track branches, C4 slug collisions, exact grant matching, DST-safe daily schedules, loud malformed asserts, portfolio locks, contained file asserts ([`45c4a43`](https://github.com/lab255/Crystal/commit/45c4a43))
- land on the Overview by default, platform-correct open-dialog placeholder, honest 'App settings…' label ([`2b4aa21`](https://github.com/lab255/Crystal/commit/2b4aa21))
- honor worktree isolation on the task card's primary Run, loud partial test failures, true shortcut hints, terminal-safe global keys, undeliverable-message truth ([`01748ee`](https://github.com/lab255/Crystal/commit/01748ee))

## v0.26.0 (2026-08-08)

### Features

- arrangeable deployment view with VPC/subnet/security-group zones ([`f63f631`](https://github.com/lab255/Crystal/commit/f63f631))
- Delegated default preset — Fable orchestration, gpt-5.6-sol coding, Sonnet merge ([`3c8d477`](https://github.com/lab255/Crystal/commit/3c8d477))
- approvable pending-permission requests in the Agents tab ([`c419cd2`](https://github.com/lab255/Crystal/commit/c419cd2))
- taskless asks land on the board; card-based answering UI ([`102bc94`](https://github.com/lab255/Crystal/commit/102bc94))
- ELK-modeled edge labels + viewport-aware packing ([`20b4a03`](https://github.com/lab255/Crystal/commit/20b4a03))
- Ask AI routes to the coordinator; robust nav drag ([`12695b7`](https://github.com/lab255/Crystal/commit/12695b7))
- network-zone node kinds; fix(client): no composer beside a live PTY ([`1fedf00`](https://github.com/lab255/Crystal/commit/1fedf00))
- closeable coordinator sessions + program management menu ([`862e7fc`](https://github.com/lab255/Crystal/commit/862e7fc))

### Bug Fixes

- hydrate scoped stores after the workspace list lands on connect ([`78b93b2`](https://github.com/lab255/Crystal/commit/78b93b2))
- disable Tauri drag-drop interception — HTML5 DnD works again ([`9fff0da`](https://github.com/lab255/Crystal/commit/9fff0da))

## v0.25.0 (2026-08-08)

### Features

- wire ELK layout into the architecture view ([`da7834c`](https://github.com/lab255/Crystal/commit/da7834c))
- ELK compound layout engine + deterministic card metrics ([`69ceb0c`](https://github.com/lab255/Crystal/commit/69ceb0c))

### Bug Fixes

- survive RF measurement races, pack degenerate ELK scopes ([`28c78d9`](https://github.com/lab255/Crystal/commit/28c78d9))

## v0.24.0 (2026-08-08)

### Features

- analysis progress, stale-serve refresh, and a real failure path ([`f940826`](https://github.com/lab255/Crystal/commit/f940826))
- native tabs/windows replace the in-app tab strip; custom titlebar ([`201a58b`](https://github.com/lab255/Crystal/commit/201a58b))
- notify on settled runs and budget/stall workflow pauses ([`443ee22`](https://github.com/lab255/Crystal/commit/443ee22))

### Bug Fixes

- let pinch/ctrl-wheel zoom through to react-flow and Monaco panes ([`eed47a5`](https://github.com/lab255/Crystal/commit/eed47a5))

### ⚠ BREAKING CHANGES

- native tabs/windows replace the in-app tab strip; custom titlebar ([`201a58b`](https://github.com/lab255/Crystal/commit/201a58b))

## v0.23.0 (2026-08-08)

### Features

- merge the API client into the API surface view ([`279c556`](https://github.com/lab255/Crystal/commit/279c556))
- C4 bar lanes, component-packed flow layout, data schema in C4 ([`8b4ac36`](https://github.com/lab255/Crystal/commit/8b4ac36))
- merge the hub into the Overview mode ([`0b2997e`](https://github.com/lab255/Crystal/commit/0b2997e))
- multi-tab and multi-window support ([`a1b50af`](https://github.com/lab255/Crystal/commit/a1b50af))
- shell IA overhaul — rail tools, three-lane navbar, viewport lock ([`be83fac`](https://github.com/lab255/Crystal/commit/be83fac))

### Bug Fixes

- scope the schema view to one project at a time ([`dea7778`](https://github.com/lab255/Crystal/commit/dea7778))

### ⚠ BREAKING CHANGES

- merge the hub into the Overview mode ([`0b2997e`](https://github.com/lab255/Crystal/commit/0b2997e))

## v0.22.0 (2026-08-08)

### Features

- C4 deep-linking, context menus and navigation polish ([`ffdc20d`](https://github.com/lab255/Crystal/commit/ffdc20d))

## v0.21.0 (2026-08-08)

### Features

- redesign the architecture view around the C4 model ([`e9d7514`](https://github.com/lab255/Crystal/commit/e9d7514))

## v0.20.0 (2026-08-04)

### Features

- simplify the workflow builder and start panel ([`aed66fd`](https://github.com/lab255/Crystal/commit/aed66fd))
- unified dispatch keymap across every composer ([`f3f0f50`](https://github.com/lab255/Crystal/commit/f3f0f50))
- IA overhaul — top navbar, workspace rail, project menu, settings ([`bf73296`](https://github.com/lab255/Crystal/commit/bf73296))
- light/dark/system theming, de-blued neutral palette ([`d517b7c`](https://github.com/lab255/Crystal/commit/d517b7c))
- publish relay, permission broker, Codex provider, agent handoff targets ([`304badc`](https://github.com/lab255/Crystal/commit/304badc))

## v0.19.0 (2026-08-03)

### Features

- cross-workspace needs-you rollup + attention notifications ([`235a4ea`](https://github.com/lab255/Crystal/commit/235a4ea))
- command palette jumps to any task across projects ([`6a98133`](https://github.com/lab255/Crystal/commit/6a98133))
- embed the interactive run's terminal in the run surface ([`9df9757`](https://github.com/lab255/Crystal/commit/9df9757))
- operator-style list+session working view with a per-task attention model ([`e5620a9`](https://github.com/lab255/Crystal/commit/e5620a9))

## v0.18.0 (2026-08-02)

### Features

- worktree merge-back, run recovery, managed services, standing tasks, insights ([`bb6092a`](https://github.com/lab255/Crystal/commit/bb6092a))

## v0.17.0 (2026-07-31)

### Features

- restore the systems-view card and pane; surface-to-API flows as real edges ([`e7d9c8b`](https://github.com/lab255/Crystal/commit/e7d9c8b))

### Bug Fixes

- closed-project terminals die cleanly and reopen with scrollback ([`ba36142`](https://github.com/lab255/Crystal/commit/ba36142))
- drop the open file when the workspace switches ([`4b4c0e5`](https://github.com/lab255/Crystal/commit/4b4c0e5))
- stop Cmd+W from quitting the app on macOS ([`44f7d43`](https://github.com/lab255/Crystal/commit/44f7d43))

## v0.16.0 (2026-07-30)

### Features

- part tier on the canvas + decorations off the structural memo ([`25dfc12`](https://github.com/lab255/Crystal/commit/25dfc12))

### Bug Fixes

- survey imports merge into the overlay; stale systems-view refs ([`799c542`](https://github.com/lab255/Crystal/commit/799c542))

## v0.15.0 (2026-07-30)

### Features

- Postman-style API client with unified environments ([`45deaba`](https://github.com/lab255/Crystal/commit/45deaba))
- DB schema viewer with ER diagrams ([`f2e77a9`](https://github.com/lab255/Crystal/commit/f2e77a9))
- module tier in the derived architecture ([`437c6ca`](https://github.com/lab255/Crystal/commit/437c6ca))
- playwright runs, real dev-server detection + rail launcher ([`9e5a8fd`](https://github.com/lab255/Crystal/commit/9e5a8fd))
- wrap overflowing toolbars, pill all tag fields ([`19ae912`](https://github.com/lab255/Crystal/commit/19ae912))
- git sidebar + rail toggles, live version badge, updater UI ([`c161307`](https://github.com/lab255/Crystal/commit/c161307))
- contract-open on link edges, facets projection, infra palette ([`afd704c`](https://github.com/lab255/Crystal/commit/afd704c))

## v0.14.0 (2026-07-29)

### Features

- premise checks, tool-grants ledger, per-run cost caps, turn-value log ([`09c8c8a`](https://github.com/lab255/Crystal/commit/09c8c8a))

## v0.13.0 (2026-07-29)

### Features

- surface the new orchestration verbs in the UI ([`c01294c`](https://github.com/lab255/Crystal/commit/c01294c))

## v0.12.0 (2026-07-29)

### Features

- steer receipts, close_delivery, compact, budget tripwire ([`7fde623`](https://github.com/lab255/Crystal/commit/7fde623))

## v0.11.0 (2026-07-29)

### Features

- typed turn outcomes + dispatch pre-flight ([`dc42d19`](https://github.com/lab255/Crystal/commit/dc42d19))

## v0.10.0 (2026-07-28)

### Features

- retire the legacy systems tab — the mode is exactly three views ([`21c3cc0`](https://github.com/lab255/Crystal/commit/21c3cc0))
- role chips + focus filter on the Architecture canvas ([`9616ff6`](https://github.com/lab255/Crystal/commit/9616ff6))
- the system map folds into the Architecture view ([`ff50dc3`](https://github.com/lab255/Crystal/commit/ff50dc3))
- categorized diff entry panel for the architecture vs-ref review; docs ([`ad83007`](https://github.com/lab255/Crystal/commit/ad83007))
- screens layer on the Architecture canvas; retire the draft-from-ref pipeline ([`1e9a01a`](https://github.com/lab255/Crystal/commit/1e9a01a))
- vs-ref drift on the Infrastructure view ([`85f1230`](https://github.com/lab255/Crystal/commit/85f1230))
- architecture view id, contracts+insights panels, named service instances ([`20d8302`](https://github.com/lab255/Crystal/commit/20d8302))
- vs-ref review on the Architecture canvas ([`67488e5`](https://github.com/lab255/Crystal/commit/67488e5))
- one canonical architecture — derived graph + overlay ([`aa72b84`](https://github.com/lab255/Crystal/commit/aa72b84))
- codebase view — code map with first-class ref review ([`3871d00`](https://github.com/lab255/Crystal/commit/3871d00))
- shared diagram foundations for the three-view consolidation ([`7213900`](https://github.com/lab255/Crystal/commit/7213900))

### ⚠ BREAKING CHANGES

- retire the legacy systems tab — the mode is exactly three views ([`21c3cc0`](https://github.com/lab255/Crystal/commit/21c3cc0))
- the system map folds into the Architecture view ([`ff50dc3`](https://github.com/lab255/Crystal/commit/ff50dc3))

## v0.9.0 (2026-07-28)

### Features

- Costs tab with per-axis spend attribution ([`e12c5df`](https://github.com/lab255/Crystal/commit/e12c5df))
- interactive-first dispatch, session-chain collapse, gated bypass permissions ([`e3f53ce`](https://github.com/lab255/Crystal/commit/e3f53ce))
- shared Select, Field and CommandList primitives across pickers ([`54c763c`](https://github.com/lab255/Crystal/commit/54c763c))

## v0.8.0 (2026-07-27)

### Features

- model presets unified with the profile/dispatch system ([`5f578ea`](https://github.com/lab255/Crystal/commit/5f578ea))
- front-and-center question inboxes in hub and board ([`483005c`](https://github.com/lab255/Crystal/commit/483005c))
- epic and owner swimlanes ([`a79d44b`](https://github.com/lab255/Crystal/commit/a79d44b))
- remote sync — pull/push/fetch with ahead/behind tracking ([`1ccc306`](https://github.com/lab255/Crystal/commit/1ccc306))

### Bug Fixes

- put the project toolchain on every spawned process's PATH ([`c1a869f`](https://github.com/lab255/Crystal/commit/c1a869f))
- answer questions whose delivery already settled ([`05aa129`](https://github.com/lab255/Crystal/commit/05aa129))

## v0.7.0 (2026-07-27)

### Features

- fleet client — one client, many bridges ([`ca1f008`](https://github.com/lab255/Crystal/commit/ca1f008))

## v0.6.0 (2026-07-27)

### Features

- roster surface, shared RunsPane, deep-linked purpose filter ([`b8806c9`](https://github.com/lab255/Crystal/commit/b8806c9))
- live instance registry + per-flavor open-workspace persistence ([`3f0f9a6`](https://github.com/lab255/Crystal/commit/3f0f9a6))

## v0.5.0 (2026-07-27)

### Features

- multi-endpoint bridge relay + instance discovery ([`aaa51e3`](https://github.com/lab255/Crystal/commit/aaa51e3))
- unified RunSurface + shared composer; hub and jobs adopt it ([`b0e0061`](https://github.com/lab255/Crystal/commit/b0e0061))
- first-class agent profiles with a two-scope library ([`f034b2c`](https://github.com/lab255/Crystal/commit/f034b2c))

### Bug Fixes

- pin GH_REPO for the checkout-less finalize job ([`87c03b4`](https://github.com/lab255/Crystal/commit/87c03b4))

## v0.4.0 (2026-07-27)

### Features

- merge_track automation, track diff chips, spend index ([`6e861e2`](https://github.com/lab255/Crystal/commit/6e861e2))
- one-click apply of an isolated run's worktree as a branch ([`1da5602`](https://github.com/lab255/Crystal/commit/1da5602))
- bill interactive runs from their session transcript ([`cf1fe91`](https://github.com/lab255/Crystal/commit/cf1fe91))
- waiting-on-you attention + board question previews ([`db7c587`](https://github.com/lab255/Crystal/commit/db7c587))
- one-click manager recovery + interactive-run surfacing ([`25b9a79`](https://github.com/lab255/Crystal/commit/25b9a79))
- interactive workflow managers + shared launch seam ([`f7e4d05`](https://github.com/lab255/Crystal/commit/f7e4d05))
- interactive terminal dispatch with board-logged questions ([`99dc7e3`](https://github.com/lab255/Crystal/commit/99dc7e3))

### Bug Fixes

- deliver worker notices into live TUIs; unpin doomed sessions ([`7437e62`](https://github.com/lab255/Crystal/commit/7437e62))
- spawned agents must not inherit the child-session marker ([`131343d`](https://github.com/lab255/Crystal/commit/131343d))
- harden interactive dispatch after adversarial self-review ([`8567232`](https://github.com/lab255/Crystal/commit/8567232))
- keep waiting-on-you counts live on board writes ([`afec634`](https://github.com/lab255/Crystal/commit/afec634))
- four defects that forced the human back into the loop ([`a03f8d2`](https://github.com/lab255/Crystal/commit/a03f8d2))

## v0.3.1 (2026-07-26)

### Bug Fixes

- binary management ([`aed3436`](https://github.com/lab255/Crystal/commit/aed3436))

## v0.3.0 (2026-07-25)

### Features

- drag-and-drop template builder with handoffs and board mapping ([`e3baf21`](https://github.com/lab255/Crystal/commit/e3baf21))
- cross-project programs dispatched to per-project orchestrators ([`a4ce96d`](https://github.com/lab255/Crystal/commit/a4ce96d))

## v0.2.0 (2026-07-20)

### Features

- global lens spanning all tools + endpoint validation + Ask AI ([`c858ffc`](https://github.com/lab255/Crystal/commit/c858ffc))

## v0.1.2 (2026-07-20)

### Bug Fixes

- Developer-ID sign node-pty's nested Mach-O for notarization ([`3dc6edf`](https://github.com/lab255/Crystal/commit/3dc6edf))

## v0.1.1 (2026-07-20)

### Bug Fixes

- strip XML comment from macOS entitlements (AMFI parse error) (#1) ([`094933b`](https://github.com/lab255/Crystal/commit/094933b))

## v0.1.0 (2026-07-19)

### Features

- macOS desktop release pipeline with signing, notarization & auto-update ([`633d7f7`](https://github.com/lab255/Crystal/commit/633d7f7))
- visual workflow builder with custom templates ([`289b656`](https://github.com/lab255/Crystal/commit/289b656))
- workflow and agent orchestration ([`4cd5db4`](https://github.com/lab255/Crystal/commit/4cd5db4))
- improve board ([`38b30a5`](https://github.com/lab255/Crystal/commit/38b30a5))
- run code-map analysis in a worker thread ([`0eb2b39`](https://github.com/lab255/Crystal/commit/0eb2b39))
- IPC-first transport with supervised sidecar ([`ae94109`](https://github.com/lab255/Crystal/commit/ae94109))
- default export handling ([`d3bf4a7`](https://github.com/lab255/Crystal/commit/d3bf4a7))
- improved codemap ([`85c8492`](https://github.com/lab255/Crystal/commit/85c8492))
- improved deeplinks and git ref review ([`469a014`](https://github.com/lab255/Crystal/commit/469a014))
- board-centric multi-agent layer with leases and cost rollups ([`917c64d`](https://github.com/lab255/Crystal/commit/917c64d))
- improved surfaces view ([`2ac13fd`](https://github.com/lab255/Crystal/commit/2ac13fd))
- the system map is the mode's front door ([`78bb737`](https://github.com/lab255/Crystal/commit/78bb737))
- trace real-world client patterns — fetch wrappers and JSX renders ([`9c6ecbd`](https://github.com/lab255/Crystal/commit/9c6ecbd))
- full-stack system map — screens, APIs and modules on one navigable canvas ([`f23d372`](https://github.com/lab255/Crystal/commit/f23d372))
- surfaces.map — per-screen API reachability for the system map ([`92a6393`](https://github.com/lab255/Crystal/commit/92a6393))
- contract for the full-stack system map (surfaces.map, map subview) ([`923e886`](https://github.com/lab255/Crystal/commit/923e886))
- improved agent management ([`2c2124b`](https://github.com/lab255/Crystal/commit/2c2124b))
- test-mirror duplicate lint, per-package generic system names ([`a1a4b97`](https://github.com/lab255/Crystal/commit/a1a4b97))
- alias guessed mode names, normalize unknown hashes ([`434b3b9`](https://github.com/lab255/Crystal/commit/434b3b9))
- tsconfig aliases, router mounts, entry-aware dead files, method dispatch ([`4c93ece`](https://github.com/lab255/Crystal/commit/4c93ece))
- monorepo-aware test detection, per-package runs, merged coverage ([`3d8eaa1`](https://github.com/lab255/Crystal/commit/3d8eaa1))
- frontend-to-backend API tracing and in-pane boundary inspection ([`72c3b8e`](https://github.com/lab255/Crystal/commit/72c3b8e))
- open side panes at half width with a prominent compact-screen expand ([`cb715be`](https://github.com/lab255/Crystal/commit/cb715be))
- shared right-click symbol menu across every view ([`1e66b05`](https://github.com/lab255/Crystal/commit/1e66b05))
- register the Surfaces and Quality modes ([`4c68c04`](https://github.com/lab255/Crystal/commit/4c68c04))
- Quality mode — integrated test runner and coverage visualiser ([`fccbf20`](https://github.com/lab255/Crystal/commit/fccbf20))
- Surfaces mode — screens, components, stories, APIs, schemas ([`37349a7`](https://github.com/lab255/Crystal/commit/37349a7))
- surfaces analysis and test-runner/coverage services ([`ffd97d2`](https://github.com/lab255/Crystal/commit/ffd97d2))
- surfaces + quality domain contracts, bridge methods and deep links ([`c0f9c7a`](https://github.com/lab255/Crystal/commit/c0f9c7a))
- API explorer, systems layout persistence, deeper contract inspection ([`e6687b0`](https://github.com/lab255/Crystal/commit/e6687b0))
- contract inspector; fix deep-link back/forward restoration ([`01286b1`](https://github.com/lab255/Crystal/commit/01286b1))
- improved architectural map ([`d86d1cf`](https://github.com/lab255/Crystal/commit/d86d1cf))
- systems overview improvements ([`59c9b9b`](https://github.com/lab255/Crystal/commit/59c9b9b))
- systems architecture mode ([`159da35`](https://github.com/lab255/Crystal/commit/159da35))
- package desktop app + remote server & web console ([`a254e4b`](https://github.com/lab255/Crystal/commit/a254e4b))
- improved architecture generation ([`9502f10`](https://github.com/lab255/Crystal/commit/9502f10))
- symbolic indexing support ([`1bad619`](https://github.com/lab255/Crystal/commit/1bad619))
- improved code indexing ([`b56cea4`](https://github.com/lab255/Crystal/commit/b56cea4))
- improved workspace and facet architecture ([`9263f15`](https://github.com/lab255/Crystal/commit/9263f15))
- improved agent run integration ([`b064d9f`](https://github.com/lab255/Crystal/commit/b064d9f))
- in-process MCP dispatch_worker server for manager runs ([`632826c`](https://github.com/lab255/Crystal/commit/632826c))
- dispatch tracked worker runs from a manager ([`5403381`](https://github.com/lab255/Crystal/commit/5403381))
- add manager/worker run hierarchy ([`a9315f4`](https://github.com/lab255/Crystal/commit/a9315f4))
- add Agents dispatch tab with reusable run sidepane ([`ed144aa`](https://github.com/lab255/Crystal/commit/ed144aa))
- emphasize hovered node instead of dimming the rest ([`4ada99c`](https://github.com/lab255/Crystal/commit/4ada99c))
- improve architect canvas and lod ([`9a8f596`](https://github.com/lab255/Crystal/commit/9a8f596))
- improve automatic facets and lod ([`f447879`](https://github.com/lab255/Crystal/commit/f447879))
- jump to a specific line from cross-mode navigation ([`caa3134`](https://github.com/lab255/Crystal/commit/caa3134))
- review sweep panel in the code map ([`d1b647c`](https://github.com/lab255/Crystal/commit/d1b647c))
- serve review.findings with re-export tracking ([`c779d2a`](https://github.com/lab255/Crystal/commit/c779d2a))
- barrel-aware review sweep and line-aware deep links ([`26793a4`](https://github.com/lab255/Crystal/commit/26793a4))
- suggested facets and intent indexing in the facets panel ([`feaf512`](https://github.com/lab255/Crystal/commit/feaf512))
- build the code index and dispatch cheap indexing agents ([`9054fe9`](https://github.com/lab255/Crystal/commit/9054fe9))
- semantic code index with deterministic tags and facet suggestions ([`4552efb`](https://github.com/lab255/Crystal/commit/4552efb))
- agent tasks and dispatch ([`34ae903`](https://github.com/lab255/Crystal/commit/34ae903))
- better lod and wiring ([`713ee61`](https://github.com/lab255/Crystal/commit/713ee61))
- improved journey and inspector panels ([`12ef610`](https://github.com/lab255/Crystal/commit/12ef610))
- facets and improved level of detail rendring ([`2c0b891`](https://github.com/lab255/Crystal/commit/2c0b891))
- architectural level of detail ([`86a6e50`](https://github.com/lab255/Crystal/commit/86a6e50))
- better terminal support ([`54d696f`](https://github.com/lab255/Crystal/commit/54d696f))
- multiproject support ([`f3abe59`](https://github.com/lab255/Crystal/commit/f3abe59))
- better diff and review ([`ad04072`](https://github.com/lab255/Crystal/commit/ad04072))
- simulation improvements ([`fb7f54c`](https://github.com/lab255/Crystal/commit/fb7f54c))
- infra simulation ([`34c4df9`](https://github.com/lab255/Crystal/commit/34c4df9))
- simulation ([`cfe03d2`](https://github.com/lab255/Crystal/commit/cfe03d2))
- level of detail rendering ([`5ef6c9f`](https://github.com/lab255/Crystal/commit/5ef6c9f))
- harbourview ([`1ccaf49`](https://github.com/lab255/Crystal/commit/1ccaf49))
- improved architecture viewer ([`175647a`](https://github.com/lab255/Crystal/commit/175647a))
- drag and drop refactoring ([`84029b3`](https://github.com/lab255/Crystal/commit/84029b3))
- deeplinking ([`893f4f1`](https://github.com/lab255/Crystal/commit/893f4f1))
- react-split-pane and architect mode ([`1011ee1`](https://github.com/lab255/Crystal/commit/1011ee1))
- dataflow and journey ([`0cc4a0a`](https://github.com/lab255/Crystal/commit/0cc4a0a))
- duplicates panel with two-up compare + hoist-to-shared-package flow ([`55111c6`](https://github.com/lab255/Crystal/commit/55111c6))
- drag-a-symbol refactor intents in draft plans + apply flow ([`8697a27`](https://github.com/lab255/Crystal/commit/8697a27))
- deterministic refactor engine — LanguageService move + manual shim fallback ([`ab9bca3`](https://github.com/lab255/Crystal/commit/ab9bca3))
- journeys — code-derived dataflow lens over the diagram ([`bbe50c3`](https://github.com/lab255/Crystal/commit/bbe50c3))
- code snippets inside diagrams and the code map ([`8ef17fe`](https://github.com/lab255/Crystal/commit/8ef17fe))
- top-down layered layout + local-first infrastructure view ([`0449ba7`](https://github.com/lab255/Crystal/commit/0449ba7))
- traffic layers, local/cloud env kinds, journeys, refactor intents ([`351bb21`](https://github.com/lab255/Crystal/commit/351bb21))
- symbol ranges, call graph, fingerprints + symbol-level codemap queries ([`cd78a22`](https://github.com/lab255/Crystal/commit/cd78a22))
- integrate code map into architecture — drill-in, context menus, draft plans, infra view ([`a55ebc6`](https://github.com/lab255/Crystal/commit/a55ebc6))
- archdraft create/update/delete actions in the workspace store ([`3fd8a02`](https://github.com/lab255/Crystal/commit/3fd8a02))
- persist architecture drafts under .crystal/architecture/drafts ([`61edfc8`](https://github.com/lab255/Crystal/commit/61edfc8))
- architecture drafts with three-way rebase, environments + placements ([`bc5bf01`](https://github.com/lab255/Crystal/commit/bc5bf01))
- codemaps ([`5004d95`](https://github.com/lab255/Crystal/commit/5004d95))

### Bug Fixes

- drop pnpm cache from plan/release jobs ([`ad244f8`](https://github.com/lab255/Crystal/commit/ad244f8))
- harden API tracing and the system map after an 8-angle review ([`19d7f6c`](https://github.com/lab255/Crystal/commit/19d7f6c))
- surfaceMap traces through the screen component's call graph ([`22537c3`](https://github.com/lab255/Crystal/commit/22537c3))
- make the desktop release workflow produce working artifacts ([`33008c5`](https://github.com/lab255/Crystal/commit/33008c5))
- bridge server connectivity ([`95dbcc1`](https://github.com/lab255/Crystal/commit/95dbcc1))
- build desktop after app ([`ccf0e9c`](https://github.com/lab255/Crystal/commit/ccf0e9c))
- better lod ([`975d7ce`](https://github.com/lab255/Crystal/commit/975d7ce))
- split screen deeplinking ([`7a6d71e`](https://github.com/lab255/Crystal/commit/7a6d71e))
- pass a refactor kind, not a display name, to getApplicableRefactors ([`92d0be6`](https://github.com/lab255/Crystal/commit/92d0be6))

### Performance

- run scene layout in web workers ([`7c3a5de`](https://github.com/lab255/Crystal/commit/7c3a5de))
- bound and coalesce the agent-event hot path ([`d193d74`](https://github.com/lab255/Crystal/commit/d193d74))
- two-phase system map build — layout once, decorate per click ([`d5437a8`](https://github.com/lab255/Crystal/commit/d5437a8))


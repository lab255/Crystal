# Changelog

## v0.7.0 (2026-07-27)

### Features

- fleet client — one client, many bridges ([`ca1f008`](https://github.com/eliotlim/crystal/commit/ca1f008))

## v0.6.0 (2026-07-27)

### Features

- roster surface, shared RunsPane, deep-linked purpose filter ([`b8806c9`](https://github.com/eliotlim/crystal/commit/b8806c9))
- live instance registry + per-flavor open-workspace persistence ([`3f0f9a6`](https://github.com/eliotlim/crystal/commit/3f0f9a6))

## v0.5.0 (2026-07-27)

### Features

- multi-endpoint bridge relay + instance discovery ([`aaa51e3`](https://github.com/eliotlim/crystal/commit/aaa51e3))
- unified RunSurface + shared composer; hub and jobs adopt it ([`b0e0061`](https://github.com/eliotlim/crystal/commit/b0e0061))
- first-class agent profiles with a two-scope library ([`f034b2c`](https://github.com/eliotlim/crystal/commit/f034b2c))

### Bug Fixes

- pin GH_REPO for the checkout-less finalize job ([`87c03b4`](https://github.com/eliotlim/crystal/commit/87c03b4))

## v0.4.0 (2026-07-27)

### Features

- merge_track automation, track diff chips, spend index ([`6e861e2`](https://github.com/eliotlim/crystal/commit/6e861e2))
- one-click apply of an isolated run's worktree as a branch ([`1da5602`](https://github.com/eliotlim/crystal/commit/1da5602))
- bill interactive runs from their session transcript ([`cf1fe91`](https://github.com/eliotlim/crystal/commit/cf1fe91))
- waiting-on-you attention + board question previews ([`db7c587`](https://github.com/eliotlim/crystal/commit/db7c587))
- one-click manager recovery + interactive-run surfacing ([`25b9a79`](https://github.com/eliotlim/crystal/commit/25b9a79))
- interactive workflow managers + shared launch seam ([`f7e4d05`](https://github.com/eliotlim/crystal/commit/f7e4d05))
- interactive terminal dispatch with board-logged questions ([`99dc7e3`](https://github.com/eliotlim/crystal/commit/99dc7e3))

### Bug Fixes

- deliver worker notices into live TUIs; unpin doomed sessions ([`7437e62`](https://github.com/eliotlim/crystal/commit/7437e62))
- spawned agents must not inherit the child-session marker ([`131343d`](https://github.com/eliotlim/crystal/commit/131343d))
- harden interactive dispatch after adversarial self-review ([`8567232`](https://github.com/eliotlim/crystal/commit/8567232))
- keep waiting-on-you counts live on board writes ([`afec634`](https://github.com/eliotlim/crystal/commit/afec634))
- four defects that forced the human back into the loop ([`a03f8d2`](https://github.com/eliotlim/crystal/commit/a03f8d2))

## v0.3.1 (2026-07-26)

### Bug Fixes

- binary management ([`aed3436`](https://github.com/eliotlim/crystal/commit/aed3436))

## v0.3.0 (2026-07-25)

### Features

- drag-and-drop template builder with handoffs and board mapping ([`e3baf21`](https://github.com/eliotlim/crystal/commit/e3baf21))
- cross-project programs dispatched to per-project orchestrators ([`a4ce96d`](https://github.com/eliotlim/crystal/commit/a4ce96d))

## v0.2.0 (2026-07-20)

### Features

- global lens spanning all tools + endpoint validation + Ask AI ([`c858ffc`](https://github.com/eliotlim/crystal/commit/c858ffc))

## v0.1.2 (2026-07-20)

### Bug Fixes

- Developer-ID sign node-pty's nested Mach-O for notarization ([`3dc6edf`](https://github.com/eliotlim/crystal/commit/3dc6edf))

## v0.1.1 (2026-07-20)

### Bug Fixes

- strip XML comment from macOS entitlements (AMFI parse error) (#1) ([`094933b`](https://github.com/eliotlim/crystal/commit/094933b))

## v0.1.0 (2026-07-19)

### Features

- macOS desktop release pipeline with signing, notarization & auto-update ([`633d7f7`](https://github.com/eliotlim/crystal/commit/633d7f7))
- visual workflow builder with custom templates ([`289b656`](https://github.com/eliotlim/crystal/commit/289b656))
- workflow and agent orchestration ([`4cd5db4`](https://github.com/eliotlim/crystal/commit/4cd5db4))
- improve board ([`38b30a5`](https://github.com/eliotlim/crystal/commit/38b30a5))
- run code-map analysis in a worker thread ([`0eb2b39`](https://github.com/eliotlim/crystal/commit/0eb2b39))
- IPC-first transport with supervised sidecar ([`ae94109`](https://github.com/eliotlim/crystal/commit/ae94109))
- default export handling ([`d3bf4a7`](https://github.com/eliotlim/crystal/commit/d3bf4a7))
- improved codemap ([`85c8492`](https://github.com/eliotlim/crystal/commit/85c8492))
- improved deeplinks and git ref review ([`469a014`](https://github.com/eliotlim/crystal/commit/469a014))
- board-centric multi-agent layer with leases and cost rollups ([`917c64d`](https://github.com/eliotlim/crystal/commit/917c64d))
- improved surfaces view ([`2ac13fd`](https://github.com/eliotlim/crystal/commit/2ac13fd))
- the system map is the mode's front door ([`78bb737`](https://github.com/eliotlim/crystal/commit/78bb737))
- trace real-world client patterns — fetch wrappers and JSX renders ([`9c6ecbd`](https://github.com/eliotlim/crystal/commit/9c6ecbd))
- full-stack system map — screens, APIs and modules on one navigable canvas ([`f23d372`](https://github.com/eliotlim/crystal/commit/f23d372))
- surfaces.map — per-screen API reachability for the system map ([`92a6393`](https://github.com/eliotlim/crystal/commit/92a6393))
- contract for the full-stack system map (surfaces.map, map subview) ([`923e886`](https://github.com/eliotlim/crystal/commit/923e886))
- improved agent management ([`2c2124b`](https://github.com/eliotlim/crystal/commit/2c2124b))
- test-mirror duplicate lint, per-package generic system names ([`a1a4b97`](https://github.com/eliotlim/crystal/commit/a1a4b97))
- alias guessed mode names, normalize unknown hashes ([`434b3b9`](https://github.com/eliotlim/crystal/commit/434b3b9))
- tsconfig aliases, router mounts, entry-aware dead files, method dispatch ([`4c93ece`](https://github.com/eliotlim/crystal/commit/4c93ece))
- monorepo-aware test detection, per-package runs, merged coverage ([`3d8eaa1`](https://github.com/eliotlim/crystal/commit/3d8eaa1))
- frontend-to-backend API tracing and in-pane boundary inspection ([`72c3b8e`](https://github.com/eliotlim/crystal/commit/72c3b8e))
- open side panes at half width with a prominent compact-screen expand ([`cb715be`](https://github.com/eliotlim/crystal/commit/cb715be))
- shared right-click symbol menu across every view ([`1e66b05`](https://github.com/eliotlim/crystal/commit/1e66b05))
- register the Surfaces and Quality modes ([`4c68c04`](https://github.com/eliotlim/crystal/commit/4c68c04))
- Quality mode — integrated test runner and coverage visualiser ([`fccbf20`](https://github.com/eliotlim/crystal/commit/fccbf20))
- Surfaces mode — screens, components, stories, APIs, schemas ([`37349a7`](https://github.com/eliotlim/crystal/commit/37349a7))
- surfaces analysis and test-runner/coverage services ([`ffd97d2`](https://github.com/eliotlim/crystal/commit/ffd97d2))
- surfaces + quality domain contracts, bridge methods and deep links ([`c0f9c7a`](https://github.com/eliotlim/crystal/commit/c0f9c7a))
- API explorer, systems layout persistence, deeper contract inspection ([`e6687b0`](https://github.com/eliotlim/crystal/commit/e6687b0))
- contract inspector; fix deep-link back/forward restoration ([`01286b1`](https://github.com/eliotlim/crystal/commit/01286b1))
- improved architectural map ([`d86d1cf`](https://github.com/eliotlim/crystal/commit/d86d1cf))
- systems overview improvements ([`59c9b9b`](https://github.com/eliotlim/crystal/commit/59c9b9b))
- systems architecture mode ([`159da35`](https://github.com/eliotlim/crystal/commit/159da35))
- package desktop app + remote server & web console ([`a254e4b`](https://github.com/eliotlim/crystal/commit/a254e4b))
- improved architecture generation ([`9502f10`](https://github.com/eliotlim/crystal/commit/9502f10))
- symbolic indexing support ([`1bad619`](https://github.com/eliotlim/crystal/commit/1bad619))
- improved code indexing ([`b56cea4`](https://github.com/eliotlim/crystal/commit/b56cea4))
- improved workspace and facet architecture ([`9263f15`](https://github.com/eliotlim/crystal/commit/9263f15))
- improved agent run integration ([`b064d9f`](https://github.com/eliotlim/crystal/commit/b064d9f))
- in-process MCP dispatch_worker server for manager runs ([`632826c`](https://github.com/eliotlim/crystal/commit/632826c))
- dispatch tracked worker runs from a manager ([`5403381`](https://github.com/eliotlim/crystal/commit/5403381))
- add manager/worker run hierarchy ([`a9315f4`](https://github.com/eliotlim/crystal/commit/a9315f4))
- add Agents dispatch tab with reusable run sidepane ([`ed144aa`](https://github.com/eliotlim/crystal/commit/ed144aa))
- emphasize hovered node instead of dimming the rest ([`4ada99c`](https://github.com/eliotlim/crystal/commit/4ada99c))
- improve architect canvas and lod ([`9a8f596`](https://github.com/eliotlim/crystal/commit/9a8f596))
- improve automatic facets and lod ([`f447879`](https://github.com/eliotlim/crystal/commit/f447879))
- jump to a specific line from cross-mode navigation ([`caa3134`](https://github.com/eliotlim/crystal/commit/caa3134))
- review sweep panel in the code map ([`d1b647c`](https://github.com/eliotlim/crystal/commit/d1b647c))
- serve review.findings with re-export tracking ([`c779d2a`](https://github.com/eliotlim/crystal/commit/c779d2a))
- barrel-aware review sweep and line-aware deep links ([`26793a4`](https://github.com/eliotlim/crystal/commit/26793a4))
- suggested facets and intent indexing in the facets panel ([`feaf512`](https://github.com/eliotlim/crystal/commit/feaf512))
- build the code index and dispatch cheap indexing agents ([`9054fe9`](https://github.com/eliotlim/crystal/commit/9054fe9))
- semantic code index with deterministic tags and facet suggestions ([`4552efb`](https://github.com/eliotlim/crystal/commit/4552efb))
- agent tasks and dispatch ([`34ae903`](https://github.com/eliotlim/crystal/commit/34ae903))
- better lod and wiring ([`713ee61`](https://github.com/eliotlim/crystal/commit/713ee61))
- improved journey and inspector panels ([`12ef610`](https://github.com/eliotlim/crystal/commit/12ef610))
- facets and improved level of detail rendring ([`2c0b891`](https://github.com/eliotlim/crystal/commit/2c0b891))
- architectural level of detail ([`86a6e50`](https://github.com/eliotlim/crystal/commit/86a6e50))
- better terminal support ([`54d696f`](https://github.com/eliotlim/crystal/commit/54d696f))
- multiproject support ([`f3abe59`](https://github.com/eliotlim/crystal/commit/f3abe59))
- better diff and review ([`ad04072`](https://github.com/eliotlim/crystal/commit/ad04072))
- simulation improvements ([`fb7f54c`](https://github.com/eliotlim/crystal/commit/fb7f54c))
- infra simulation ([`34c4df9`](https://github.com/eliotlim/crystal/commit/34c4df9))
- simulation ([`cfe03d2`](https://github.com/eliotlim/crystal/commit/cfe03d2))
- level of detail rendering ([`5ef6c9f`](https://github.com/eliotlim/crystal/commit/5ef6c9f))
- harbourview ([`1ccaf49`](https://github.com/eliotlim/crystal/commit/1ccaf49))
- improved architecture viewer ([`175647a`](https://github.com/eliotlim/crystal/commit/175647a))
- drag and drop refactoring ([`84029b3`](https://github.com/eliotlim/crystal/commit/84029b3))
- deeplinking ([`893f4f1`](https://github.com/eliotlim/crystal/commit/893f4f1))
- react-split-pane and architect mode ([`1011ee1`](https://github.com/eliotlim/crystal/commit/1011ee1))
- dataflow and journey ([`0cc4a0a`](https://github.com/eliotlim/crystal/commit/0cc4a0a))
- duplicates panel with two-up compare + hoist-to-shared-package flow ([`55111c6`](https://github.com/eliotlim/crystal/commit/55111c6))
- drag-a-symbol refactor intents in draft plans + apply flow ([`8697a27`](https://github.com/eliotlim/crystal/commit/8697a27))
- deterministic refactor engine — LanguageService move + manual shim fallback ([`ab9bca3`](https://github.com/eliotlim/crystal/commit/ab9bca3))
- journeys — code-derived dataflow lens over the diagram ([`bbe50c3`](https://github.com/eliotlim/crystal/commit/bbe50c3))
- code snippets inside diagrams and the code map ([`8ef17fe`](https://github.com/eliotlim/crystal/commit/8ef17fe))
- top-down layered layout + local-first infrastructure view ([`0449ba7`](https://github.com/eliotlim/crystal/commit/0449ba7))
- traffic layers, local/cloud env kinds, journeys, refactor intents ([`351bb21`](https://github.com/eliotlim/crystal/commit/351bb21))
- symbol ranges, call graph, fingerprints + symbol-level codemap queries ([`cd78a22`](https://github.com/eliotlim/crystal/commit/cd78a22))
- integrate code map into architecture — drill-in, context menus, draft plans, infra view ([`a55ebc6`](https://github.com/eliotlim/crystal/commit/a55ebc6))
- archdraft create/update/delete actions in the workspace store ([`3fd8a02`](https://github.com/eliotlim/crystal/commit/3fd8a02))
- persist architecture drafts under .crystal/architecture/drafts ([`61edfc8`](https://github.com/eliotlim/crystal/commit/61edfc8))
- architecture drafts with three-way rebase, environments + placements ([`bc5bf01`](https://github.com/eliotlim/crystal/commit/bc5bf01))
- codemaps ([`5004d95`](https://github.com/eliotlim/crystal/commit/5004d95))

### Bug Fixes

- drop pnpm cache from plan/release jobs ([`ad244f8`](https://github.com/eliotlim/crystal/commit/ad244f8))
- harden API tracing and the system map after an 8-angle review ([`19d7f6c`](https://github.com/eliotlim/crystal/commit/19d7f6c))
- surfaceMap traces through the screen component's call graph ([`22537c3`](https://github.com/eliotlim/crystal/commit/22537c3))
- make the desktop release workflow produce working artifacts ([`33008c5`](https://github.com/eliotlim/crystal/commit/33008c5))
- bridge server connectivity ([`95dbcc1`](https://github.com/eliotlim/crystal/commit/95dbcc1))
- build desktop after app ([`ccf0e9c`](https://github.com/eliotlim/crystal/commit/ccf0e9c))
- better lod ([`975d7ce`](https://github.com/eliotlim/crystal/commit/975d7ce))
- split screen deeplinking ([`7a6d71e`](https://github.com/eliotlim/crystal/commit/7a6d71e))
- pass a refactor kind, not a display name, to getApplicableRefactors ([`92d0be6`](https://github.com/eliotlim/crystal/commit/92d0be6))

### Performance

- run scene layout in web workers ([`7c3a5de`](https://github.com/eliotlim/crystal/commit/7c3a5de))
- bound and coalesce the agent-event hot path ([`d193d74`](https://github.com/eliotlim/crystal/commit/d193d74))
- two-phase system map build — layout once, decorate per click ([`d5437a8`](https://github.com/eliotlim/crystal/commit/d5437a8))


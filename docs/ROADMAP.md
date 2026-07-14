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

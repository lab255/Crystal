# Execution plan — LoD ladder & facet lenses in the architecture view (DRAFT)

Status: phases 1–4 shipped on `main` (this change set); phases 5–7 are the
proposed follow-on. Owner: architecture mode. Last updated: 2026-07-07.

## Goal

Let an engineer set *how much* of the codebase the architecture view exposes
(one global knob: repositories → packages → modules → members) and *which
slice* of it they are looking at (facets like Authentication or Booking that
filter the map down to exactly the members involved) — so a codebase can be
understood at a glance and then interrogated without changing views.

## What shipped (phases 1–4)

### 1. Core model
- `CODE_LOD_LEVELS` / `CodeLodLevel` + `lodIndex` (`packages/core/src/codemap.ts`)
  — the 4-stop ladder. **repos** = workspace repo + nested `.git` modules,
  **packages** = code-map modules, **modules** = files (ES modules),
  **members** = top-level symbols.
- Deep links: `lod=` and `lens=` params on `#/architect/codemap`
  (`packages/core/src/deeplink.ts`) — levels and facet lenses are shareable
  and survive reload/back/forward.
- Facet lenses over the code index (`packages/core/src/code-index.ts`):
  `indexFacetVisibility(index, tags)` → files/members/modules a tag set
  exposes (test files excluded unless asked for); `suggestIndexFacets(index)`
  → ranked lens suggestions straight from the index, no diagram needed;
  `parseLensTags`.

### 2. Server
- `codemap.details` bridge method → `CodeMapAnalyzer.bulkDetails()`
  (`apps/server/src/code-map.ts`): every module + file detail in one
  round-trip (the members level would otherwise be hundreds of requests;
  measured ~5 ms on this repo's 291 files once analysis is warm).

### 3. Code map UI (`packages/architect/src/codemap/`)
- `LodSlider.tsx` — discrete 4-stop slider with per-level entity counts,
  keyboard access (keys 1–4), placed in a new detail/focus bar under the
  breadcrumbs.
- Level semantics: repos renders a repo-grouped scene
  (`groupModulesByRepo`), packages collapses everything, modules expands all
  packages to file cards, members expands all files to symbol chips. Manual
  per-node toggles keep working on top of the chosen level.
- **Stable layout**: once bulk details load, dagre lays every module out at
  its members-level footprint (`memberFootprint`, `MapSceneInput.layoutSizes`)
  — the layout is *positioned for the fully exposed view*; coarser levels
  render collapsed cards centered in the same slots, so sliding the knob
  swaps detail without re-arranging the map.
- `FacetsPanel.tsx` — suggested facets (name, members/files/modules counts,
  sample files) computed live from the code index; one click applies a lens,
  `codeindex.changed` keeps suggestions fresh.
- Lens behavior: the scene hides modules/files/members outside the lens
  (`MapSceneInput.lens`), auto-expands what remains down to the member chips,
  refits the viewport, and shows an exit chip with match counts. Lens layout
  is compact on purpose (a lens exists to trim the canvas).
- QoL: `Nf`/`Nm` badges on module headers (files/members at a glance), lens
  empty-state, counts on the slider, eager bulk load on workspaces ≤ 2000
  files.

### 4. Facet discovery loop
- Automatic: heuristic tags (names/paths/kinds/fan-in) are always on — the
  panel suggests facets with zero setup.
- Agent traversal: the panel's "Index intents with an agent" dispatches the
  existing `codeindex.enrich` run (haiku by default, `purpose:index`); its
  enrichment tags land in `.crystal/index/`, the watcher fires
  `codeindex.changed`, and lens/suggestions sharpen in place.

Verification so far: 386 vitest tests green (new coverage for the codec, lens
visibility, suggestions, bulk serving, repo grouping, reserved layout,
footprint math); live bridge run on this repo (18 modules / 291 files / 1460
members; `intent:auth` lens → 12 files) and on the ledgerline + driftwood
fixtures (ledgerline: 4 packages → 32 modules → 85 members; top facet
`intent:api` trims to 47 members).

## Proposed next phases

### 5. Facets as first-class, saveable objects (M)
- Persist accepted lenses (name + tags + optional pinned member refs) in the
  workspace — likely `.crystal/facets.json` or per-architecture facets that
  carry `tags` in addition to `nodeIds` — so a team's facets version with the
  repo like everything else.
- Right-click a symbol chip → "add to facet" (explicit member refs beyond
  tag matches, mirroring the diagram facets' membership editing).
- Unify naming/UX with the diagrams-view facet chip (same lens language).

### 6. LoD ↔ diagrams unification (M/L)
- The hand-authored diagram canvas has its own zoom-driven auto-detail
  (`evaluateLod`); offer the same discrete 4-stop knob there, driving
  `codeExpanded`/`expandedFiles` through the reserved-slot machinery that
  already exists, with `lod=` shared across subviews.
- Repos stop could optionally hand off to the cross-workspace map when >1
  workspace is open.

### 7. Glance-layer polish (S, pick freely)
- Facet coverage bar (what % of members the active lens covers) and per-facet
  accent coloring of matched chips when *not* lensing (highlight instead of
  filter mode).
- Minimap tinting by facet match; lens-aware symbol search.
- Escape exits the lens; `[`/`]` step the ladder.
- Perf guard: virtualize member chips past ~3k visible symbols (react-flow
  node count is the practical ceiling on giant repos at members level).

## Risks / open questions
- **Scale**: members level on a 8k-file workspace produces tens of thousands
  of nodes; the >2000-file eager-load guard exists, but a hard cap or
  per-viewport virtualization is the real fix (phase 7).
- **Lens vs. drafts**: move-intent ghosts render inside lensed scenes; ghost
  targets outside the lens are currently hidden — decide whether a lens
  should always reveal draft targets.
- **Heuristic noise**: the built-in lexicon over-matches on infrastructure
  words (`api`, `server`); agent enrichment corrects this, so consider
  down-weighting heuristic-only matches in suggestions once a file is
  enriched.

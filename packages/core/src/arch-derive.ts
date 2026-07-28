import type {
  ArchEdge,
  ArchNode,
  ArchNodeKind,
  ArchitectureGraph,
} from "./architecture.js";
import type { CodeModule } from "./codemap.js";
import type { DiffMarks } from "./diagram-diff.js";
import { ARCH_KIND_OF_CATEGORY, type CodeExternalDep } from "./external-services.js";
import type { SystemLink, SystemModule, SystemOverview, SystemRole } from "./system-overview.js";
import type { SystemChange, SystemOverviewDiff } from "./system-insights.js";

/**
 * The one canonical architecture, derived. Where the old diagrams view
 * rendered a hand-saved graph and the systems view a read-only overview,
 * this projects `codemap.overview` (+ detected external services) into an
 * `ArchitectureGraph` with **stable canonical ids** — the overlay
 * (`arch-overlay.ts`) keys every user customization on them:
 *
 *   `sys:<slug>`        a logical system (the overview's own id, stabilized)
 *   `ext:<service-id>`  a detected external service (queue, bucket, SaaS…)
 *   `link:<a>-><b>`     a system→system edge
 *   `extlink:<a>-><b>`  a system→external edge
 *
 * Pure and worker-safe: same input → same graph, positions all zero (layout
 * is the renderer's job; the overlay overrides what the user dragged).
 */

export interface DeriveInput {
  overview: SystemOverview;
  /** Detected external services (CodeMapSummary.externals). */
  externals: readonly CodeExternalDep[];
  /** Code-map modules — used to pick a resolvable `codeModule` per system. */
  modules: readonly CodeModule[];
}

/** Role → node kind (the systems view's mapping, layer-refined below). */
const KIND_OF_ROLE: Record<SystemRole, ArchNodeKind> = {
  domain: "service",
  integration: "external",
  data: "datastore",
  shared: "package",
  entry: "gateway",
};

const ROLE_LABEL: Record<SystemRole, string> = {
  domain: "domain",
  integration: "integration",
  shared: "shared",
  entry: "entry",
  data: "data",
};

function kindOfSystem(s: SystemModule): ArchNodeKind {
  if (s.layer === "frontend") return "frontend";
  if (s.layer === "database") return "datastore";
  return KIND_OF_ROLE[s.role];
}

const slug = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/**
 * The overview disambiguates slug collisions with positional suffixes
 * ("sys:api-2") — unstable across re-derivations (dropping the first "api"
 * cluster renames the second). Canonical ids re-key every *suffixed* member
 * of a collision group by its primary part path instead, which follows the
 * directory, not the ordering.
 */
export function canonicalSystemIds(systems: readonly SystemModule[]): Map<string, string> {
  const ids = new Set(systems.map((s) => s.id));
  const out = new Map<string, string>();
  for (const s of systems) {
    const m = /^(.*)-(\d+)$/.exec(s.id);
    if (m && ids.has(m[1]!)) {
      const part = s.parts[0]?.path ?? s.parts[0]?.pkg ?? String(m[2]);
      out.set(s.id, `${m[1]}@${slug(part)}`);
    } else {
      out.set(s.id, s.id);
    }
  }
  return out;
}

export const externalNodeIdOf = (serviceId: string): string => `ext:${serviceId}`;
export const linkEdgeId = (source: string, target: string): string => `link:${source}->${target}`;
export const extLinkEdgeId = (source: string, target: string): string =>
  `extlink:${source}->${target}`;

/** Deepest system part (by path prefix) owning a code-map module path. */
function systemOfModule(
  modulePath: string,
  systems: readonly SystemModule[],
  idOf: (raw: string) => string,
): string | null {
  let best: { id: string; len: number } | null = null;
  for (const s of systems) {
    for (const p of s.parts) {
      for (const candidate of [p.path, p.pkg]) {
        if (candidate !== modulePath && !modulePath.startsWith(`${candidate}/`) && candidate !== ".")
          continue;
        const len = candidate === "." ? 0 : candidate.length;
        if (!best || len > best.len) best = { id: idOf(s.id), len };
      }
    }
  }
  return best?.id ?? null;
}

function edgeKindForCategory(category: CodeExternalDep["category"]): ArchEdge["kind"] {
  if (category === "queue" || category === "realtime") return "async";
  if (
    category === "database" ||
    category === "cache" ||
    category === "storage" ||
    category === "search"
  )
    return "data";
  return "sync";
}

export function deriveArchGraph(input: DeriveInput): ArchitectureGraph {
  const { overview, externals, modules } = input;
  const idOfRaw = canonicalSystemIds(overview.systems);
  const idOf = (raw: string) => idOfRaw.get(raw) ?? raw;
  const modulePaths = new Set(modules.map((m) => m.path));

  const nodes: ArchNode[] = overview.systems.map((s) => {
    const primary = s.parts[0];
    // Prefer the part directory when the code map knows it as a module (dir
    // modules in single-package repos) — finer LOD expansion; else the
    // owning package, which is always resolvable.
    const codeModule = primary
      ? modulePaths.has(primary.path)
        ? primary.path
        : primary.pkg
      : null;
    return {
      id: idOf(s.id),
      kind: kindOfSystem(s),
      label: s.name,
      description: `${s.fileCount} files · ${ROLE_LABEL[s.role]}`,
      parentId: null,
      position: { x: 0, y: 0 },
      size: null,
      tech: s.libraries.slice(0, 4).map((l) => l.pkg),
      codeModule,
      placements: {},
      layer: null,
    };
  });

  const edges: ArchEdge[] = overview.links.map((l) => ({
    id: linkEdgeId(idOf(l.source), idOf(l.target)),
    source: idOf(l.source),
    target: idOf(l.target),
    kind: l.apis?.length ? "sync" : "dependency",
    label: l.weight > 1 ? String(l.weight) : "",
  }));

  // Detected external services — each queue/bucket/SaaS a distinct node,
  // wired from the systems whose modules import its client packages.
  const edgeIds = new Set(edges.map((e) => e.id));
  for (const dep of externals) {
    const extId = externalNodeIdOf(dep.id);
    nodes.push({
      id: extId,
      kind: ARCH_KIND_OF_CATEGORY[dep.category] ?? "external",
      label: dep.name,
      description: `detected from ${dep.packages.join(", ")}`,
      parentId: null,
      position: { x: 0, y: 0 },
      size: null,
      tech: [...dep.packages],
      placements: {},
      layer: null,
    });
    const consumers = new Map<string, number>();
    for (const client of dep.clients) {
      const sys = systemOfModule(client.module, overview.systems, idOf);
      if (sys) consumers.set(sys, (consumers.get(sys) ?? 0) + client.weight);
    }
    for (const [sys, weight] of consumers) {
      const id = extLinkEdgeId(sys, extId);
      if (edgeIds.has(id)) continue;
      edgeIds.add(id);
      edges.push({
        id,
        source: sys,
        target: extId,
        kind: edgeKindForCategory(dep.category),
        label: weight > 1 ? String(weight) : "",
      });
    }
  }

  return {
    id: "arch:derived",
    name: "Architecture",
    description: "Derived from the code map — customizations live in the overlay",
    nodes,
    edges,
    environments: [],
    journeys: [],
    facets: [],
  };
}

/* ------------------------------------------------------------------ */
/* Ref review — overview diff projected onto canonical ids             */
/* ------------------------------------------------------------------ */

/**
 * `diffSystemOverviews` output → the shared mark vocabulary, keyed by the
 * canonical ids the derived graph uses. External add/removes fold into a
 * `changed` mark on their system (the external node itself may serve many
 * systems, and the diff attributes per system).
 */
export function overviewDiffMarks(
  diff: SystemOverviewDiff,
  idOf: (raw: string) => string = (raw) => raw,
): DiffMarks {
  const marks: DiffMarks = {};
  for (const s of diff.addedSystems) marks[idOf(s.id)] = { kind: "added" };
  for (const s of diff.removedSystems) marks[idOf(s.id)] = { kind: "removed", ghost: true };
  for (const r of diff.resized)
    marks[idOf(r.id)] = { kind: "changed", detail: `${r.before} → ${r.after} files` };
  for (const l of diff.addedLinks)
    marks[linkEdgeId(idOf(l.source), idOf(l.target))] = { kind: "added" };
  for (const l of diff.removedLinks)
    marks[linkEdgeId(idOf(l.source), idOf(l.target))] = { kind: "removed", ghost: true };
  for (const l of diff.reweighted)
    marks[linkEdgeId(idOf(l.source), idOf(l.target))] = {
      kind: "changed",
      detail: `${l.before} → ${l.after} imports`,
    };
  const externalNote = (system: string, note: string) => {
    const id = idOf(system);
    const prior = marks[id];
    if (prior?.kind === "added" || prior?.kind === "removed") return;
    const detail = prior?.detail ? `${prior.detail} · ${note}` : note;
    marks[id] = { kind: "changed", detail };
  };
  for (const e of diff.addedExternals) externalNote(e.system, `+${e.name}`);
  for (const e of diff.removedExternals) externalNote(e.system, `−${e.name}`);
  return marks;
}

/**
 * Ghost nodes/edges for base-only systems and links, merged into the derived
 * graph before layout so removals occupy space (`mergeGhosts` convention).
 */
export function overviewDiffGhosts(
  diff: SystemOverviewDiff,
  idOf: (raw: string) => string = (raw) => raw,
): { nodes: ArchNode[]; edges: ArchEdge[] } {
  const nodes: ArchNode[] = diff.removedSystems.map((s: SystemChange) => ({
    id: idOf(s.id),
    kind: KIND_OF_ROLE[s.role],
    label: s.name,
    description: `${s.fileCount} files · removed vs the review ref`,
    parentId: null,
    position: { x: 0, y: 0 },
    size: null,
    tech: [],
    placements: {},
    layer: null,
  }));
  const edges: ArchEdge[] = diff.removedLinks.map((l) => ({
    id: linkEdgeId(idOf(l.source), idOf(l.target)),
    source: idOf(l.source),
    target: idOf(l.target),
    kind: "dependency",
    label: l.weight > 1 ? String(l.weight) : "",
  }));
  return { nodes, edges };
}

/** Re-derive `SystemLink` lookups keyed by canonical edge id (panel drills). */
export function linkByEdgeId(
  overview: SystemOverview,
  idOf: (raw: string) => string,
): Map<string, SystemLink> {
  const map = new Map<string, SystemLink>();
  for (const l of overview.links) map.set(linkEdgeId(idOf(l.source), idOf(l.target)), l);
  return map;
}

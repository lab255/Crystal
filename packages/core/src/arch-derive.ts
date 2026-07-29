import type {
  ArchEdge,
  ArchNode,
  ArchNodeKind,
  ArchitectureGraph,
} from "./architecture.js";
import type { CodeModule } from "./codemap.js";
import type { DiffMarks } from "./diagram-diff.js";
import { ARCH_KIND_OF_CATEGORY, type CodeExternalDep } from "./external-services.js";
import type { ScreenApiCall, ScreenSurface } from "./surfaces.js";
import type { SystemLink, SystemModule, SystemOverview, SystemRole } from "./system-overview.js";
import { computeSystemInsights, type SystemChange, type SystemOverviewDiff } from "./system-insights.js";

/**
 * The one canonical architecture, derived. Where the old diagrams view
 * rendered a hand-saved graph and the systems view a read-only overview,
 * this projects `codemap.overview` (+ detected external services) into an
 * `ArchitectureGraph` with **stable canonical ids** — the overlay
 * (`arch-overlay.ts`) keys every user customization on them:
 *
 *   `sys:<slug>`        a logical system (the overview's own id, stabilized)
 *   `mod:<slug>`        a code module grouping the systems it owns (≥2)
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
  /**
   * Screens layer (the surfaces map, folded in): screens render as frontend
   * nodes grouped by owning module, and their API reachability becomes
   * screen→system flow edges. Null/absent leaves the layer off.
   */
  surfaces?: { screens: readonly ScreenSurface[]; calls: readonly ScreenApiCall[] } | null;
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
export const moduleNodeIdOf = (modulePath: string): string => `mod:${slug(modulePath)}`;
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

/** Longest symbol name shown on an edge label before truncation. */
const LINK_LABEL_SYMBOL_MAX = 18;

/**
 * What a derived link shows on the wire — the retired systems view's
 * vocabulary: the top crossing symbol with the import weight
 * ("createForm ×12"), or the top matched route for api-only boundaries
 * ("GET /api/forms +2").
 */
function linkLabel(l: SystemLink): string {
  if (l.weight === 0 && l.apis?.length) {
    const api = l.apis[0]!;
    const more = l.apis.length - 1;
    return `${api.method} ${api.path}${more > 0 ? ` +${more}` : ""}`;
  }
  const top = l.symbols[0];
  if (!top) return l.weight > 1 ? String(l.weight) : "";
  const name =
    top.length > LINK_LABEL_SYMBOL_MAX ? `${top.slice(0, LINK_LABEL_SYMBOL_MAX - 1)}…` : top;
  return l.weight > 1 ? `${name} ×${l.weight}` : name;
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

  // Module tier — the axis the retired systems view grouped by ("By module")
  // and the consolidation dropped: systems nest inside the code module that
  // owns them, so the canvas reads as modules-of-systems rather than a flat
  // mesh of directory clusters. A module container is emitted only when it
  // owns ≥2 systems (a one-system module IS its system) and only when the
  // workspace has ≥2 owning modules at all (one wrapper box around
  // everything is noise, not structure).
  const moduleOfSystem = (s: SystemModule): string | null => {
    const counts = new Map<string, number>();
    for (const p of s.parts) {
      if (!p.pkg || p.pkg === ".") continue;
      counts.set(p.pkg, (counts.get(p.pkg) ?? 0) + Math.max(1, p.fileCount));
    }
    let best: string | null = null;
    let bestWeight = 0;
    for (const [pkg, weight] of counts) {
      if (weight > bestWeight) {
        best = pkg;
        bestWeight = weight;
      }
    }
    return best;
  };
  const systemsByModule = new Map<string, string[]>();
  for (const s of overview.systems) {
    const owner = moduleOfSystem(s);
    if (!owner) continue;
    systemsByModule.set(owner, [...(systemsByModule.get(owner) ?? []), idOf(s.id)]);
  }
  if (systemsByModule.size >= 2) {
    const nodeById = new Map(nodes.map((n) => [n.id, n]));
    for (const [modulePath, members] of systemsByModule) {
      if (members.length < 2) continue;
      const moduleName = modules.find((m) => m.path === modulePath)?.name ?? modulePath;
      const files = members.reduce((n, id) => {
        const raw = overview.systems.find((s) => idOf(s.id) === id);
        return n + (raw?.fileCount ?? 0);
      }, 0);
      nodes.push({
        id: moduleNodeIdOf(modulePath),
        kind: "group",
        label: moduleName,
        description: `module · ${members.length} systems · ${files} files`,
        parentId: null,
        position: { x: 0, y: 0 },
        size: null,
        tech: [],
        codeModule: modulePath,
        placements: {},
        layer: null,
      });
      for (const id of members) {
        const node = nodeById.get(id);
        if (node) node.parentId = moduleNodeIdOf(modulePath);
      }
    }
  }

  // Edges carry what the old systems view showed on them: the top crossing
  // symbol (or route) as the label, the raw weight for stroke scaling, an
  // api-only flag ("talks over the wire, no imports") and cycle membership.
  const cyclePairs = new Set(
    computeSystemInsights(overview).cycles.flatMap((c) =>
      c.edges.map((e) => `${e.source}->${e.target}`),
    ),
  );
  const edges: ArchEdge[] = overview.links.map((l) => {
    const apiOnly = l.weight === 0 && (l.apis?.length ?? 0) > 0;
    return {
      id: linkEdgeId(idOf(l.source), idOf(l.target)),
      source: idOf(l.source),
      target: idOf(l.target),
      kind: l.apis?.length ? "sync" : "dependency",
      label: linkLabel(l),
      weight: apiOnly ? (l.apis?.reduce((n, a) => n + a.weight, 0) ?? 0) : l.weight,
      ...(apiOnly ? { apiOnly: true } : {}),
      ...(cyclePairs.has(`${l.source}->${l.target}`) ? { cycle: true } : {}),
    };
  });

  // Detected external services — each named bucket/queue/topic/table its own
  // node when a literal name was discoverable, the service-level node as the
  // fallback (and for clients no named instance claims). Every box is wired
  // from the systems whose modules import the client packages.
  const edgeIds = new Set(edges.map((e) => e.id));
  const pushExternal = (
    dep: CodeExternalDep,
    extId: string,
    label: string,
    description: string,
    clients: readonly { module: string; weight: number }[],
  ) => {
    nodes.push({
      id: extId,
      kind: ARCH_KIND_OF_CATEGORY[dep.category] ?? "external",
      label,
      description,
      parentId: null,
      position: { x: 0, y: 0 },
      size: null,
      tech: [...dep.packages],
      placements: {},
      layer: null,
    });
    const consumers = new Map<string, number>();
    for (const client of clients) {
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
        weight,
      });
    }
  };
  for (const dep of externals) {
    const instances = dep.instances ?? [];
    const claimed = new Set<string>();
    for (const inst of instances) {
      pushExternal(
        dep,
        `${externalNodeIdOf(dep.id)}:${slug(inst.name)}`,
        inst.name,
        `${dep.name} · detected from ${dep.packages.join(", ")}`,
        inst.clients,
      );
      for (const c of inst.clients) claimed.add(c.module);
    }
    // Clients no named instance claims still need the service-level box.
    const residual =
      instances.length === 0 ? dep.clients : dep.clients.filter((c) => !claimed.has(c.module));
    if (instances.length === 0 || residual.length > 0) {
      pushExternal(
        dep,
        externalNodeIdOf(dep.id),
        dep.name,
        `detected from ${dep.packages.join(", ")}`,
        residual,
      );
    }
  }

  // Screens layer: each screen a frontend node grouped by its owning module,
  // its matched API calls becoming screen→system flow edges — the surfaces
  // system map's reachability story on the one canvas.
  if (input.surfaces) {
    const { screens, calls } = input.surfaces;
    const groupOf = (file: string): string => {
      let best = ".";
      for (const m of modules) {
        if (m.path === ".") continue;
        if ((file === m.path || file.startsWith(`${m.path}/`)) && m.path.length > best.length)
          best = m.path;
      }
      return best;
    };
    const groups = new Map<string, string>(); // module path → container id
    for (const screen of screens) {
      const moduleOfScreen = groupOf(screen.file);
      let groupId = groups.get(moduleOfScreen);
      if (!groupId) {
        groupId = `screens:${slug(moduleOfScreen)}`;
        groups.set(moduleOfScreen, groupId);
        const moduleName =
          modules.find((m) => m.path === moduleOfScreen)?.name ?? moduleOfScreen;
        nodes.push({
          id: groupId,
          kind: "group",
          label: `${moduleName} screens`,
          description: "",
          parentId: null,
          position: { x: 0, y: 0 },
          size: { width: 420, height: 280 },
          tech: [],
          codeModule: moduleOfScreen === "." ? null : moduleOfScreen,
          placements: {},
          layer: "entry",
        });
      }
      nodes.push({
        id: `screen:${screen.id}`,
        kind: "frontend",
        label: screen.route || screen.component || screen.id,
        description: screen.component ?? "",
        parentId: groupId,
        position: { x: 0, y: 0 },
        size: null,
        tech: [],
        codeFile: screen.componentFile ?? screen.file,
        placements: {},
        layer: "entry",
      });
    }
    const screenIds = new Set(screens.map((s) => `screen:${s.id}`));
    const flows = new Map<string, { source: string; target: string; weight: number }>();
    for (const call of calls) {
      const source = `screen:${call.screen}`;
      if (!call.endpoint || !screenIds.has(source)) continue;
      const target = systemOfModule(call.endpoint.file, overview.systems, idOf);
      if (!target) continue;
      const key = `${source}\0${target}`;
      const entry = flows.get(key) ?? { source, target, weight: 0 };
      entry.weight += 1;
      flows.set(key, entry);
    }
    for (const { source, target, weight } of flows.values()) {
      edges.push({
        id: `flow:${source}->${target}`,
        source,
        target,
        kind: "sync",
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

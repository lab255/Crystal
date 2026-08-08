import type { ArchEdge, ArchNode, ArchitectureGraph } from "./architecture.js";
import { canonicalSystemIds } from "./arch-derive.js";
import type { CodeModule, CodeModuleDep } from "./codemap.js";
import type { DiffMark, DiffMarks } from "./diagram-diff.js";
import type { CodeExternalDep, ExternalServiceCategory } from "./external-services.js";
import type { ScreenSurface } from "./surfaces.js";
import type { SystemModule, SystemOverview } from "./system-overview.js";

/**
 * The C4 tier over the canonical architecture (https://c4model.com).
 *
 * C4 reads a software system at four zoom levels — System Context (people and
 * neighbouring systems), Containers (separately deployable/runnable units),
 * Components (the building blocks inside one container) and Code. Crystal's
 * canonical graph already holds the raw material: the overview's logical
 * systems are the *component* tier, detected external services split into
 * owned infrastructure (databases, queues — C4 containers) versus external
 * SaaS systems, and zoom-into-code is a live level 4.
 *
 * Two things are genuinely new here:
 *
 *  - `deriveC4Model` finds the *container* tier — deployable units derived
 *    from module signals (serves HTTP, owns screens, sits at the top of the
 *    import graph) with each logical system assigned to exactly one — plus
 *    the default `User` person when the workspace serves screens.
 *  - `projectC4` renders one C4 level as a plain `ArchitectureGraph` from the
 *    composed canonical graph, aggregating cross-boundary edges and reporting
 *    how hidden ids rolled up (`nodeRollup`/`edgeRollup`) so diff marks,
 *    journeys and highlights survive every altitude.
 *
 * Everything here is pure and worker-safe: no layout (positions zeroed), no
 * side effects, plain records only. Ids are stable and join the overlay:
 *
 *   `person:user`      the derived default actor (manual persons mint uids)
 *   `c4:system`        the software-system boundary/card
 *   `ctr:<slug>`       a derived container (`ctr:shared` for library code)
 *   `c4rel:<a>-><b>`   an aggregated relationship at coarser levels
 */

/* ------------------------------------------------------------------ */
/* Levels                                                              */
/* ------------------------------------------------------------------ */

export const C4_LEVELS = ["context", "containers", "components"] as const;
export type C4Level = (typeof C4_LEVELS)[number];

/** One C4 altitude; `scope` is the container id at the components level. */
export interface C4View {
  level: C4Level;
  scope?: string | null;
}

export const C4_LEVEL_LABELS: Record<C4Level, string> = {
  context: "System Context",
  containers: "Containers",
  components: "Components",
};

export const C4_SYSTEM_ID = "c4:system";
export const C4_USER_PERSON_ID = "person:user";
export const C4_SHARED_CONTAINER_ID = "ctr:shared";

const slug = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

export const containerNodeIdOf = (modulePath: string): string => `ctr:${slug(modulePath)}`;
export const c4RelId = (source: string, target: string): string => `c4rel:${source}->${target}`;

/**
 * Stable key for one C4 view — the per-level manual layout in the overlay
 * (`ArchOverlay.c4Layouts`) and the deep-link `scope` param key on it.
 */
export function c4ViewKey(view: C4View): string {
  return view.level === "components" && view.scope
    ? `components:${view.scope}`
    : view.level;
}

/* ------------------------------------------------------------------ */
/* External split: owned infrastructure vs external systems            */
/* ------------------------------------------------------------------ */

/**
 * C4 draws a line straight through the detected services: a database, cache
 * or queue the code talks to is part of the system being built (a container
 * inside the boundary), while a SaaS API is another software system outside
 * it. Categories decide — the node label carries the packages either way, so
 * a mis-classification stays visible and correctable.
 */
const INFRA_CATEGORIES: ReadonlySet<ExternalServiceCategory> = new Set([
  "database",
  "cache",
  "queue",
  "storage",
  "search",
  "realtime",
]);

export function isInfraCategory(category: ExternalServiceCategory): boolean {
  return INFRA_CATEGORIES.has(category);
}

/** The relationship verb C4 wants on an arrow into a service of this category. */
export function relationVerb(category: ExternalServiceCategory | null): string {
  switch (category) {
    case "database":
      return "Reads / writes";
    case "cache":
      return "Caches in";
    case "queue":
      return "Publishes / consumes";
    case "storage":
      return "Stores files in";
    case "search":
      return "Queries";
    case "realtime":
      return "Pushes events via";
    case "email":
      return "Sends email via";
    case "auth":
      return "Authenticates via";
    case "payments":
      return "Takes payment via";
    case "monitoring":
      return "Reports telemetry to";
    default:
      return "Calls";
  }
}

/* ------------------------------------------------------------------ */
/* Model derivation                                                    */
/* ------------------------------------------------------------------ */

export type C4ContainerVariant = "web" | "server" | "fullstack" | "shared";

export const C4_VARIANT_LABELS: Record<C4ContainerVariant, string> = {
  web: "Web application",
  server: "Server application",
  fullstack: "Web + server application",
  shared: "Shared library code",
};

export interface C4Container {
  /** `ctr:<module-slug>`, or `ctr:shared` for the library-code container. */
  id: string;
  name: string;
  variant: C4ContainerVariant;
  /** Top libraries across member systems — the C4 technology line. */
  tech: string[];
  /** Canonical system ids assigned to this container. */
  memberSystemIds: string[];
  /** Owning code-map module (null for the synthetic shared container). */
  modulePath: string | null;
  fileCount: number;
}

export interface C4Model {
  systemName: string;
  systemDescription: string;
  containers: C4Container[];
  /** Canonical system id → owning container id (total over all systems). */
  containerOfSystem: Record<string, string>;
  /** Code-map module path → container id (screens/routes attribution). */
  containerOfModule: Record<string, string>;
  /** External service id → its category (splits infra from external systems). */
  categoryOfService: Record<string, ExternalServiceCategory>;
  /** External service id → display name ("PostgreSQL") — the C4 technology line. */
  nameOfService: Record<string, string>;
  /** True when the workspace serves screens — derives the default User person. */
  hasScreens: boolean;
}

export interface C4DeriveInput {
  overview: SystemOverview;
  externals: readonly CodeExternalDep[];
  modules: readonly CodeModule[];
  /** Module-level import edges (CodeMapSummary.deps) — top-of-graph detection. */
  deps?: readonly CodeModuleDep[];
  screens?: readonly ScreenSurface[] | null;
}

/** Dominant part package of a system (the module that owns most of its files). */
function ownerModuleOf(s: SystemModule): string | null {
  const counts = new Map<string, number>();
  for (const p of s.parts) {
    if (!p.pkg) continue;
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
}

/** Top aggregated libraries across a set of systems, heaviest first. */
function aggregateTech(systems: readonly SystemModule[], cap = 4): string[] {
  const weights = new Map<string, number>();
  for (const s of systems) {
    for (const lib of s.libraries) {
      weights.set(lib.pkg, (weights.get(lib.pkg) ?? 0) + lib.weight);
    }
  }
  return [...weights.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, cap)
    .map(([pkg]) => pkg);
}

/**
 * Derive the C4 container tier. A module *seeds* a container when it carries a
 * deployable signal: it serves HTTP routes, it owns screens/frontend systems,
 * or it sits at the top of the module import graph (imports others, imported
 * by none — where apps live in a monorepo). Systems in non-seed modules fold
 * into the single app when there is exactly one, and into the explicit
 * `Shared components` container when several apps would otherwise each claim
 * them — shared code ships inside every one of those apps, and one honest box
 * beats a misleading attribution.
 *
 * Repos where nothing seeds (single package, pure library) fall back to the
 * systems' own layers: frontend systems form a web container, the rest an
 * application container — so the container level always exists.
 */
export function deriveC4Model(input: C4DeriveInput): C4Model {
  const { overview, externals, modules, deps, screens } = input;
  const idOfRaw = canonicalSystemIds(overview.systems);
  const idOf = (raw: string) => idOfRaw.get(raw) ?? raw;

  const categoryOfService: Record<string, ExternalServiceCategory> = {};
  const nameOfService: Record<string, string> = {};
  for (const dep of externals) {
    categoryOfService[dep.id] = dep.category;
    nameOfService[dep.id] = dep.name;
  }

  // Per-module facts.
  const systemsOfModule = new Map<string, SystemModule[]>();
  for (const s of overview.systems) {
    const owner = ownerModuleOf(s) ?? ".";
    systemsOfModule.set(owner, [...(systemsOfModule.get(owner) ?? []), s]);
  }
  const importedBy = new Map<string, number>();
  const importsOut = new Map<string, number>();
  for (const d of deps ?? []) {
    importedBy.set(d.target, (importedBy.get(d.target) ?? 0) + 1);
    importsOut.set(d.source, (importsOut.get(d.source) ?? 0) + 1);
  }
  const screensOfModule = new Map<string, number>();
  for (const screen of screens ?? []) {
    let best = ".";
    for (const m of modules) {
      if (m.path === ".") continue;
      if (
        (screen.file === m.path || screen.file.startsWith(`${m.path}/`)) &&
        m.path.length > best.length
      )
        best = m.path;
    }
    screensOfModule.set(best, (screensOfModule.get(best) ?? 0) + 1);
  }

  const moduleFacts = (m: CodeModule) => {
    const owned = systemsOfModule.get(m.path) ?? [];
    const servesHttp = owned.some((s) => s.endpoints.length > 0);
    const ownsFrontend =
      (screensOfModule.get(m.path) ?? 0) > 0 || owned.some((s) => s.layer === "frontend");
    const topOfGraph =
      (deps?.length ?? 0) > 0 &&
      (importedBy.get(m.path) ?? 0) === 0 &&
      (importsOut.get(m.path) ?? 0) > 0;
    return { owned, servesHttp, ownsFrontend, topOfGraph };
  };

  // The root module never seeds — a single-package repo takes the layer
  // fallback below, which splits web from server more honestly than one
  // whole-repo box would.
  const seeds = modules.filter((m) => {
    if (m.path === ".") return false;
    const f = moduleFacts(m);
    if (f.owned.length === 0) return false;
    return f.servesHttp || f.ownsFrontend || f.topOfGraph;
  });

  const containers: C4Container[] = [];
  const containerOfSystem: Record<string, string> = {};
  const containerOfModule: Record<string, string> = {};

  const variantFor = (servesHttp: boolean, ownsFrontend: boolean): C4ContainerVariant =>
    servesHttp && ownsFrontend ? "fullstack" : ownsFrontend ? "web" : "server";

  if (seeds.length > 0) {
    for (const m of seeds) {
      const f = moduleFacts(m);
      containers.push({
        id: containerNodeIdOf(m.path),
        name: m.name,
        variant: variantFor(f.servesHttp, f.ownsFrontend),
        tech: aggregateTech(f.owned),
        memberSystemIds: f.owned.map((s) => idOf(s.id)),
        modulePath: m.path,
        fileCount: f.owned.reduce((n, s) => n + s.fileCount, 0),
      });
      containerOfModule[m.path] = containerNodeIdOf(m.path);
      for (const s of f.owned) containerOfSystem[idOf(s.id)] = containerNodeIdOf(m.path);
    }
    // Library code: into the single app when there is one, else the explicit
    // shared container.
    const rest = overview.systems.filter((s) => !(idOf(s.id) in containerOfSystem));
    if (rest.length > 0) {
      const home =
        seeds.length === 1
          ? containers[0]!
          : (() => {
              const shared: C4Container = {
                id: C4_SHARED_CONTAINER_ID,
                name: "Shared components",
                variant: "shared",
                tech: aggregateTech(rest),
                memberSystemIds: [],
                modulePath: null,
                fileCount: 0,
              };
              containers.push(shared);
              return shared;
            })();
      for (const s of rest) {
        containerOfSystem[idOf(s.id)] = home.id;
        home.memberSystemIds.push(idOf(s.id));
        home.fileCount += s.fileCount;
      }
    }
    for (const m of modules) {
      if (!(m.path in containerOfModule)) {
        containerOfModule[m.path] =
          seeds.length === 1 ? containers[0]!.id : C4_SHARED_CONTAINER_ID;
      }
    }
  } else {
    // Layer fallback: the container level must exist even for a single
    // package with no deployable signals.
    const frontend = overview.systems.filter((s) => s.layer === "frontend");
    const backend = overview.systems.filter((s) => s.layer !== "frontend");
    const mk = (id: string, name: string, variant: C4ContainerVariant, members: SystemModule[]) => {
      containers.push({
        id,
        name,
        variant,
        tech: aggregateTech(members),
        memberSystemIds: members.map((s) => idOf(s.id)),
        modulePath: null,
        fileCount: members.reduce((n, s) => n + s.fileCount, 0),
      });
      for (const s of members) containerOfSystem[idOf(s.id)] = id;
    };
    if (frontend.length > 0 && backend.length > 0) {
      mk("ctr:web", "Web app", "web", frontend);
      mk("ctr:app", "Application", "server", backend);
    } else if (overview.systems.length > 0) {
      mk(
        "ctr:app",
        "Application",
        frontend.length > 0 ? "web" : "server",
        overview.systems.slice(),
      );
    }
    const fallback = containers[0]?.id;
    if (fallback) {
      for (const m of modules) {
        // Attribute each module to the container owning most of its systems.
        const owned = systemsOfModule.get(m.path) ?? [];
        const counts = new Map<string, number>();
        for (const s of owned) {
          const c = containerOfSystem[idOf(s.id)];
          if (c) counts.set(c, (counts.get(c) ?? 0) + s.fileCount);
        }
        let best = fallback;
        let bestWeight = 0;
        for (const [c, w] of counts) {
          if (w > bestWeight) {
            best = c;
            bestWeight = w;
          }
        }
        containerOfModule[m.path] = best;
      }
    }
  }

  const hasScreens =
    (screens?.length ?? 0) > 0 || overview.systems.some((s) => s.layer === "frontend");
  const rootName = modules.find((m) => m.path === ".")?.name;
  return {
    systemName: rootName && rootName !== "." ? rootName : "Software system",
    systemDescription: `${overview.fileTotal} files · ${containers.length} container${
      containers.length === 1 ? "" : "s"
    }`,
    containers,
    containerOfSystem,
    containerOfModule,
    categoryOfService,
    nameOfService,
    hasScreens,
  };
}

/* ------------------------------------------------------------------ */
/* Projection                                                          */
/* ------------------------------------------------------------------ */

export interface C4Projection {
  graph: ArchitectureGraph;
  /**
   * C4 metadata line per visible node — "Person", "Software System",
   * "Container · Web application", "Component · domain"… The renderer wraps
   * it in the conventional brackets.
   */
  typeLines: Record<string, string>;
  /** Hidden input node id → the visible node it rolled up into. */
  nodeRollup: Record<string, string>;
  /** Hidden input edge id → the visible aggregate edge it rolled up into. */
  edgeRollup: Record<string, string>;
  /** Node id → the view a drill-down (double-click) enters. */
  drill: Record<string, C4View>;
  view: C4View;
}

export interface C4ProjectInput {
  /** The composed canonical graph (ghosts merged by the caller if reviewing). */
  graph: ArchitectureGraph;
  model: C4Model;
  view: C4View;
  /**
   * Overlay manual edges — may reference aggregate ids (person→container…)
   * that the canonical composition drops as dangling. Re-attached here when
   * both endpoints are visible at this level.
   */
  manualEdges?: readonly ArchEdge[];
}

type NodeClass =
  | { kind: "person" }
  | { kind: "component"; container: string | null }
  | { kind: "infra" }
  | { kind: "externalSystem" }
  | { kind: "citizen" } // manual root nodes that live inside the boundary
  | { kind: "note" }
  | { kind: "transparent" }; // mod: grouping tier — dropped, children reclassified

/** Service id of an `ext:` node id ("ext:s3:uploads" → "s3"), else null. */
function serviceIdOf(nodeId: string): string | null {
  if (!nodeId.startsWith("ext:")) return null;
  return nodeId.split(":")[1] ?? null;
}

function classify(node: ArchNode, model: C4Model, byId: Map<string, ArchNode>): NodeClass {
  if (node.kind === "person") return { kind: "person" };
  if (node.kind === "note") return { kind: "note" };
  if (node.id.startsWith("mod:")) return { kind: "transparent" };
  const svc = serviceIdOf(node.id);
  if (svc) {
    const category = model.categoryOfService[svc] ?? null;
    return category && isInfraCategory(category) ? { kind: "infra" } : { kind: "externalSystem" };
  }
  const container = model.containerOfSystem[node.id];
  if (container) return { kind: "component", container };
  if (node.id.startsWith("screens:") || node.id.startsWith("screen:")) {
    const group = node.id.startsWith("screen:")
      ? node.parentId
        ? byId.get(node.parentId)
        : undefined
      : node;
    const modulePath = group?.codeModule ?? ".";
    return { kind: "component", container: model.containerOfModule[modulePath] ?? null };
  }
  if (node.id.startsWith("routes:") || node.id.startsWith("ep:")) {
    const ownerSys = node.id.startsWith("routes:")
      ? node.id.slice("routes:".length)
      : node.parentId?.startsWith("routes:")
        ? node.parentId.slice("routes:".length)
        : null;
    return {
      kind: "component",
      container: ownerSys ? (model.containerOfSystem[ownerSys] ?? null) : null,
    };
  }
  // Manual nodes: nested ones follow their parent; datastore-ish kinds are
  // infrastructure containers; external is an external system; the rest are
  // container-level citizens inside the boundary.
  if (node.parentId) {
    const parent = byId.get(node.parentId);
    if (parent) {
      const parentClass = classify(parent, model, byId);
      if (parentClass.kind === "component") return parentClass;
    }
  }
  if (node.kind === "datastore" || node.kind === "cache" || node.kind === "queue")
    return { kind: "infra" };
  if (node.kind === "external") return { kind: "externalSystem" };
  // Diff ghosts of removed systems land here too: component of no container.
  if (node.id.startsWith("sys:") || node.id.includes("@")) {
    return { kind: "component", container: null };
  }
  return { kind: "citizen" };
}

function makeNode(partial: Partial<ArchNode> & Pick<ArchNode, "id" | "kind" | "label">): ArchNode {
  return {
    description: "",
    parentId: null,
    size: null,
    tech: [],
    placements: {},
    layer: null,
    ...partial,
    position: partial.position ?? { x: 0, y: 0 },
  };
}

function personNodes(graph: ArchitectureGraph, model: C4Model): ArchNode[] {
  const manual = graph.nodes.filter((n) => n.kind === "person");
  const out: ArchNode[] = manual.map((n) => ({ ...n, parentId: null }));
  if (model.hasScreens && !manual.some((n) => n.id === C4_USER_PERSON_ID)) {
    out.unshift(
      makeNode({
        id: C4_USER_PERSON_ID,
        kind: "person",
        label: "User",
        description: "Uses the product through its screens",
      }),
    );
  }
  return out;
}

/** Aggregate several parallel edges into one C4 relationship edge. */
interface RelAccumulator {
  source: string;
  target: string;
  weight: number;
  memberEdgeIds: string[];
  hasApi: boolean;
  kinds: Map<ArchEdge["kind"], number>;
  category: ExternalServiceCategory | null;
}

function relInto(
  rels: Map<string, RelAccumulator>,
  source: string,
  target: string,
  edge: ArchEdge,
  category: ExternalServiceCategory | null,
) {
  const id = c4RelId(source, target);
  const acc: RelAccumulator = rels.get(id) ?? {
    source,
    target,
    weight: 0,
    memberEdgeIds: [],
    hasApi: false,
    kinds: new Map(),
    category,
  };
  acc.weight += edge.weight ?? 0;
  acc.memberEdgeIds.push(edge.id);
  if (edge.apiOnly || edge.id.startsWith("flow:")) acc.hasApi = true;
  acc.kinds.set(edge.kind, (acc.kinds.get(edge.kind) ?? 0) + (edge.weight ?? 1));
  if (category) acc.category = category;
  rels.set(id, acc);
}

function relEdges(rels: Map<string, RelAccumulator>, edgeRollup: Record<string, string>): ArchEdge[] {
  const out: ArchEdge[] = [];
  for (const [id, acc] of rels) {
    for (const member of acc.memberEdgeIds) edgeRollup[member] = id;
    let kind: ArchEdge["kind"] = "dependency";
    let kindWeight = -1;
    for (const [k, w] of acc.kinds) {
      if (w > kindWeight) {
        kind = k;
        kindWeight = w;
      }
    }
    const label = acc.category
      ? `${relationVerb(acc.category)}${acc.weight > 1 ? ` ×${acc.weight}` : ""}`
      : acc.hasApi
        ? "Uses · HTTP API"
        : acc.weight > 0
          ? `Uses · imports ×${acc.weight}`
          : "Uses";
    out.push({
      id,
      source: acc.source,
      target: acc.target,
      kind: acc.hasApi && kind === "dependency" ? "sync" : kind,
      label,
      ...(acc.weight > 0 ? { weight: acc.weight } : {}),
      ...(acc.hasApi ? { apiOnly: true } : {}),
    });
  }
  return out;
}

/**
 * Render one C4 level from the composed canonical graph. Output is a plain
 * `ArchitectureGraph` with positions zeroed — the caller lays it out (and
 * pins any per-level manual positions from the overlay).
 */
export function projectC4(input: C4ProjectInput): C4Projection {
  const { graph, model, view } = input;
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const classOf = new Map<string, NodeClass>();
  for (const n of graph.nodes) classOf.set(n.id, classify(n, model, byId));

  const typeLines: Record<string, string> = {};
  const nodeRollup: Record<string, string> = {};
  const edgeRollup: Record<string, string> = {};
  const drill: Record<string, C4View> = {};
  const nodes: ArchNode[] = [];
  const edges: ArchEdge[] = [];
  const rels = new Map<string, RelAccumulator>();

  const containerById = new Map(model.containers.map((c) => [c.id, c]));
  const persons = personNodes(graph, model);
  for (const p of persons) typeLines[p.id] = "Person";

  const serviceCategoryOfNode = (id: string): ExternalServiceCategory | null => {
    const svc = serviceIdOf(id);
    if (svc) return model.categoryOfService[svc] ?? null;
    const node = byId.get(id);
    if (!node) return null;
    if (node.kind === "datastore") return "database";
    if (node.kind === "cache") return "cache";
    if (node.kind === "queue") return "queue";
    return null;
  };

  const externalTypeLine = (id: string): string => {
    const category = serviceCategoryOfNode(id);
    return category ? `External System · ${category}` : "External System";
  };
  const infraTypeLine = (id: string): string => {
    const svc = serviceIdOf(id);
    const tech = (svc ? model.nameOfService[svc] : null) ?? byId.get(id)?.tech[0] ?? null;
    return tech ? `Container · ${tech}` : "Container";
  };

  const containerCard = (c: C4Container, parentId: string | null): ArchNode => {
    typeLines[c.id] = `Container · ${C4_VARIANT_LABELS[c.variant]}`;
    drill[c.id] = { level: "components", scope: c.id };
    return makeNode({
      id: c.id,
      kind: "container",
      label: c.name,
      description: `${c.memberSystemIds.length} component${
        c.memberSystemIds.length === 1 ? "" : "s"
      } · ${c.fileCount} files`,
      parentId,
      tech: c.tech,
      codeModule: c.modulePath,
    });
  };

  if (view.level === "context") {
    /* People, the system as one box, and the external systems around it. */
    nodes.push(...persons);
    nodes.push(
      makeNode({
        id: C4_SYSTEM_ID,
        kind: "system",
        label: model.systemName,
        description: model.systemDescription,
      }),
    );
    typeLines[C4_SYSTEM_ID] = "Software System";
    drill[C4_SYSTEM_ID] = { level: "containers" };

    for (const n of graph.nodes) {
      const cls = classOf.get(n.id)!;
      if (cls.kind === "externalSystem") {
        nodes.push({ ...n, parentId: null });
        typeLines[n.id] = externalTypeLine(n.id);
      } else if (cls.kind === "person" || cls.kind === "note") {
        if (cls.kind === "note") nodes.push({ ...n, parentId: null });
      } else {
        nodeRollup[n.id] = C4_SYSTEM_ID;
      }
    }
    const visible = new Set(nodes.map((n) => n.id));
    for (const e of graph.edges) {
      const source = visible.has(e.source) ? e.source : (nodeRollup[e.source] ?? null);
      const target = visible.has(e.target) ? e.target : (nodeRollup[e.target] ?? null);
      if (!source || !target || source === target) continue;
      if (visible.has(e.source) && visible.has(e.target)) {
        edges.push(e);
        continue;
      }
      relInto(rels, source, target, e, serviceCategoryOfNode(e.target));
    }
    for (const p of persons) {
      if (p.id === C4_USER_PERSON_ID) {
        const id = c4RelId(p.id, C4_SYSTEM_ID);
        edges.push({ id, source: p.id, target: C4_SYSTEM_ID, kind: "sync", label: "Uses" });
      }
    }
  } else if (view.level === "containers") {
    /* People outside; the boundary holding containers + owned infrastructure;
       external systems around it. */
    nodes.push(...persons);
    nodes.push(
      makeNode({
        id: C4_SYSTEM_ID,
        kind: "system",
        label: model.systemName,
        description: model.systemDescription,
        size: { width: 640, height: 420 },
      }),
    );
    typeLines[C4_SYSTEM_ID] = "Software System";

    for (const c of model.containers) nodes.push(containerCard(c, C4_SYSTEM_ID));

    for (const n of graph.nodes) {
      const cls = classOf.get(n.id)!;
      switch (cls.kind) {
        case "externalSystem":
          nodes.push({ ...n, parentId: null });
          typeLines[n.id] = externalTypeLine(n.id);
          break;
        case "infra":
          nodes.push({ ...n, parentId: C4_SYSTEM_ID });
          typeLines[n.id] = infraTypeLine(n.id);
          break;
        case "citizen":
          nodes.push({ ...n, parentId: C4_SYSTEM_ID });
          break;
        case "note":
          nodes.push({ ...n, parentId: null });
          break;
        case "component":
          if (cls.container) {
            nodeRollup[n.id] = cls.container;
          } else {
            // Unassigned components (review ghosts of removed systems) —
            // rendered inside the boundary so the removal stays visible.
            nodes.push({ ...n, parentId: C4_SYSTEM_ID });
          }
          break;
        case "person":
        case "transparent":
          break;
      }
    }

    const visible = new Set(nodes.map((n) => n.id));
    for (const e of graph.edges) {
      const source = visible.has(e.source) ? e.source : (nodeRollup[e.source] ?? null);
      const target = visible.has(e.target) ? e.target : (nodeRollup[e.target] ?? null);
      if (!source || !target || source === target) continue;
      if (visible.has(e.source) && visible.has(e.target)) {
        edges.push(e);
        continue;
      }
      relInto(rels, source, target, e, serviceCategoryOfNode(e.target));
    }
    // The default user reaches the containers with screens.
    if (persons.some((p) => p.id === C4_USER_PERSON_ID)) {
      for (const c of model.containers) {
        if (c.variant === "web" || c.variant === "fullstack") {
          const id = c4RelId(C4_USER_PERSON_ID, c.id);
          edges.push({ id, source: C4_USER_PERSON_ID, target: c.id, kind: "sync", label: "Uses" });
        }
      }
    }
  } else {
    /* Components of one container: the boundary is the scoped container, its
       members render verbatim, and everything they talk to shows compactly
       around it. */
    const scope = view.scope ? containerById.get(view.scope) : undefined;
    const scopeId = scope?.id ?? view.scope ?? C4_SHARED_CONTAINER_ID;
    nodes.push(
      makeNode({
        id: scopeId,
        kind: "system",
        label: scope?.name ?? scopeId,
        description: scope ? C4_VARIANT_LABELS[scope.variant] : "",
        size: { width: 640, height: 420 },
        tech: scope?.tech ?? [],
        codeModule: scope?.modulePath ?? null,
      }),
    );
    typeLines[scopeId] = scope ? `Container · ${C4_VARIANT_LABELS[scope.variant]}` : "Container";

    const memberIds = new Set<string>();
    for (const n of graph.nodes) {
      const cls = classOf.get(n.id)!;
      if (cls.kind !== "component" || cls.container !== scopeId) continue;
      memberIds.add(n.id);
    }
    for (const n of graph.nodes) {
      if (!memberIds.has(n.id)) continue;
      const parentVisible = n.parentId != null && memberIds.has(n.parentId);
      nodes.push({ ...n, parentId: parentVisible ? n.parentId : scopeId });
      if (!(n.id in typeLines)) {
        typeLines[n.id] = n.id.startsWith("screens:")
          ? "Component · screens"
          : n.id.startsWith("screen:")
            ? "Component · screen"
            : n.id.startsWith("routes:")
              ? "Component · routes"
              : n.id.startsWith("ep:")
                ? "Endpoint"
                : "Component";
      }
    }

    // Neighbors: whatever the members exchange with, one hop out.
    const visible = new Set(nodes.map((n) => n.id));
    const ensureNeighbor = (id: string): string | null => {
      if (visible.has(id)) return id;
      const cls = classOf.get(id);
      if (!cls) return null;
      if (cls.kind === "infra" || cls.kind === "externalSystem" || cls.kind === "citizen") {
        const n = byId.get(id);
        if (!n) return null;
        nodes.push({ ...n, parentId: null });
        visible.add(id);
        typeLines[id] = cls.kind === "externalSystem" ? externalTypeLine(id) : infraTypeLine(id);
        return id;
      }
      if (cls.kind === "component") {
        const home = cls.container;
        if (!home || home === scopeId) return null;
        if (!visible.has(home)) {
          const c = containerById.get(home);
          if (!c) return null;
          nodes.push(containerCard(c, null));
          visible.add(home);
        }
        nodeRollup[id] = home;
        return home;
      }
      return null;
    };

    for (const e of graph.edges) {
      const inS = memberIds.has(e.source);
      const inT = memberIds.has(e.target);
      if (!inS && !inT) {
        // Fully foreign — invisible at this scope; no rollup target.
        continue;
      }
      if (inS && inT) {
        edges.push(e);
        continue;
      }
      const source = inS ? e.source : ensureNeighbor(e.source);
      const target = inT ? e.target : ensureNeighbor(e.target);
      if (!source || !target || source === target) continue;
      relInto(rels, source, target, e, serviceCategoryOfNode(e.target));
    }

    // The user reaches into web containers' screens.
    if (
      (scope?.variant === "web" || scope?.variant === "fullstack") &&
      persons.some((p) => p.id === C4_USER_PERSON_ID)
    ) {
      const user = persons.find((p) => p.id === C4_USER_PERSON_ID)!;
      nodes.push(user);
      edges.push({
        id: c4RelId(user.id, scopeId),
        source: user.id,
        target: scopeId,
        kind: "sync",
        label: "Uses",
      });
    }
    // Notes pinned into the scope stay with it.
    for (const n of graph.nodes) {
      if (classOf.get(n.id)!.kind === "note" && n.parentId != null && memberIds.has(n.parentId)) {
        nodes.push(n);
      }
    }
  }

  edges.push(...relEdges(rels, edgeRollup));

  // Manual edges whose endpoints only exist at this altitude (person→container…).
  const visibleIds = new Set(nodes.map((n) => n.id));
  const edgeIds = new Set(edges.map((e) => e.id));
  for (const e of input.manualEdges ?? []) {
    if (edgeIds.has(e.id)) continue;
    if (visibleIds.has(e.source) && visibleIds.has(e.target)) {
      edges.push(e);
      edgeIds.add(e.id);
    }
  }

  // Every component drills into code via its codeModule; containers drill into
  // their components (`drill` filled as cards were minted).
  return {
    graph: {
      id: `arch:c4:${c4ViewKey(view)}`,
      name: `C4 · ${C4_LEVEL_LABELS[view.level]}`,
      description: graph.description,
      nodes,
      edges,
      environments: graph.environments,
      journeys: graph.journeys,
      facets: graph.facets,
      viewport: null,
    },
    typeLines,
    nodeRollup,
    edgeRollup,
    drill,
    view,
  };
}

/* ------------------------------------------------------------------ */
/* Diff-mark roll-up                                                   */
/* ------------------------------------------------------------------ */

const countLabel = (n: number, word: string) => `${n} ${word}`;

/**
 * Project review marks through a C4 projection: marks on visible ids ride
 * verbatim; marks on rolled-up ids fold into their aggregate as a `changed`
 * mark whose detail counts what happened inside ("2 added · 1 removed").
 * A direct mark on the aggregate itself (rare) wins over fold-ins.
 */
export function rollupC4Marks(marks: DiffMarks, projection: C4Projection): DiffMarks {
  const visibleNodes = new Set(projection.graph.nodes.map((n) => n.id));
  const visibleEdges = new Set(projection.graph.edges.map((e) => e.id));
  const out: DiffMarks = {};
  const folded = new Map<string, { added: number; removed: number; changed: number }>();

  for (const [id, mark] of Object.entries(marks)) {
    if (visibleNodes.has(id) || visibleEdges.has(id)) {
      out[id] = mark;
      continue;
    }
    const target = projection.nodeRollup[id] ?? projection.edgeRollup[id];
    if (!target) continue;
    const acc = folded.get(target) ?? { added: 0, removed: 0, changed: 0 };
    acc[mark.kind] += 1;
    folded.set(target, acc);
  }
  for (const [target, acc] of folded) {
    if (out[target]) continue; // a direct mark on the aggregate wins
    const parts = [
      acc.added > 0 ? countLabel(acc.added, "added") : null,
      acc.removed > 0 ? countLabel(acc.removed, "removed") : null,
      acc.changed > 0 ? countLabel(acc.changed, "changed") : null,
    ].filter((p): p is string => p != null);
    if (parts.length === 0) continue;
    out[target] = { kind: "changed", detail: parts.join(" · ") };
  }
  return out;
}

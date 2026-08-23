/**
 * C4 component tier — the abstraction the Components altitude renders.
 *
 * c4model.com defines a component as "a grouping of related functionality
 * encapsulated behind a well-defined interface", one level above code:
 * NOT a file, class or schema entity. Crystal mints components from
 * (logical system × role group): the system overview already clusters files
 * by concern (booking, auth, workflows…) and `SystemModule.groups` bands
 * each system's files by role (screens, service, data access…). A component
 * card carries the c4-style triple — name, stereotype ("Component ·
 * Service"), description — plus its *interface* (the exported symbols code
 * outside the component actually imports) and the member-file list that
 * lets marks, lenses and live-code expansion resolve it back to real code.
 *
 * Granularity contract: a container should project to roughly 5–30
 * components. Small systems stay ONE component (their dominant role); only
 * systems past MIN_ROLE_SPLIT_FILES split into per-role components. Files,
 * screens and schema entities never render as top-level members again —
 * they nest (capped) under, or roll up into, their owning component.
 *
 * `deriveC4Components` is pure and cheap (overview-sized inputs, no file
 * I/O) so clients derive it in the same memo as `deriveC4Model`.
 */

import type { C4Model } from "./c4.js";
import { canonicalSystemIds } from "./arch-derive.js";
import { isFrontendRole, roleRank, type CodeRole } from "./code-roles.js";
import type { SchemaSurface, ScreenSurface } from "./surfaces.js";
import type { SystemExport, SystemOverview } from "./system-overview.js";

/** Node-id prefix of the component tier ("cmp:<container-slug>/<system-slug>[.<role>]"). */
export const COMPONENT_ID_PREFIX = "cmp:";

export function isComponentId(id: string): boolean {
  return id.startsWith(COMPONENT_ID_PREFIX);
}

/**
 * Stereotype nouns per role — the `[Component: …]` line on the card, and the
 * suffix of a split component's name ("Booking screens"). Frontend roles read
 * as React vocabulary; backend roles as tiers.
 */
export const COMPONENT_ROLE_LABELS: Record<CodeRole, string> = {
  entry: "API endpoints",
  service: "Service",
  data: "Data access",
  provider: "State & providers",
  layout: "Screens",
  component: "UI components",
  query: "API client",
  other: "Modules",
};

/** One component card of the C4 Components altitude. */
export interface C4Component {
  /** "cmp:<container-slug>/<system-slug>" — "." + role appended when the system splits. */
  id: string;
  containerId: string;
  /** Canonical `sys:` id the component was minted from. */
  systemId: string;
  role: CodeRole;
  /** Display name — the system name, or "<System> <role label>" when split. */
  name: string;
  /** Stereotype noun for the type line, e.g. "Service", "UI components". */
  stereotype: string;
  /** Deterministic one-liner: what it does / exposes, from real facts only. */
  description: string;
  /** Dominant intent concept inherited from the system, when tag-driven. */
  concern: string | null;
  /** Member files (workspace-relative), capped — see filesTruncated. */
  files: string[];
  fileCount: number;
  filesTruncated?: boolean;
  /** The well-defined interface: exports consumed from outside, top first (capped). */
  interface: SystemExport[];
  /** Total externally-consumed exports beyond the cap. */
  interfaceTotal: number;
  /** Top libraries the component leans on. */
  tech: string[];
  screenCount: number;
  endpointCount: number;
  /** Schema entities owned by member files (0 when schemas not provided). */
  entityCount: number;
}

/** An aggregated edge between two components (or a component and a neighbor). */
export interface C4ComponentEdge {
  source: string;
  target: string;
  /** Import statements (or matched API calls) crossing the boundary. */
  weight: number;
  kind: "imports" | "api";
  /** Most-imported symbol names along the edge (capped). */
  symbols?: string[];
}

export interface C4ComponentModel {
  /** Components per container id, projection order (band order, then size). */
  byContainer: Record<string, C4Component[]>;
  /** Workspace-relative file → owning component id (capped members only). */
  componentOfFile: Record<string, string>;
  /** Canonical `sys:` id → its primary component (rollup target for sys-id marks/links). */
  componentOfSystem: Record<string, string>;
  /** Component-to-component edges across the whole model (both intra- and cross-container). */
  edges: C4ComponentEdge[];
}

export interface C4ComponentsInput {
  model: C4Model;
  overview: SystemOverview;
  screens?: readonly ScreenSurface[] | null;
  schemas?: readonly SchemaSurface[] | null;
}

/** A system splits into per-role components only past this many files. */
export const MIN_ROLE_SPLIT_FILES = 12;
/** A role group below this many files folds into the system's primary component. */
export const MIN_GROUP_FILES = 3;
/** Interface symbols carried per component card. */
export const COMPONENT_INTERFACE_CAP = 6;
/** Member files carried per component (beyond it, only fileCount is known). */
export const COMPONENT_FILE_CAP = 200;
/** Schema entities rendered under one component before the remainder roll up. */
export const ENTITY_NEST_CAP = 6;

export function describeComponent(component: C4Component): string {
  const head = component.role === "entry"
    ? `Serves ${component.endpointCount} routes`
    : component.role === "layout"
      ? `${component.screenCount} screens`
      : component.role === "component"
        ? `${component.fileCount} UI components`
        : component.role === "data"
          ? "Data access"
          : component.role === "service"
            ? "Business logic"
            : component.role === "provider"
              ? "App state"
              : component.role === "query"
                ? "Client API calls"
                : "Shared modules";
  return [
    head,
    component.interface.length ? `exposes ${component.interface.slice(0, 2).map((e) => e.name).join(", ")}` : "",
    `${component.fileCount} files`,
    component.entityCount > 0 ? `${component.entityCount} entities` : "",
  ].filter(Boolean).join(" · ");
}

const systemSlug = (id: string): string => id.replace(/^sys:/, "").replace(/[@/]/g, "-");

/** Derive deterministic semantic components and their cross-component relationships. */
export function deriveC4Components(input: C4ComponentsInput): C4ComponentModel {
  const { model, overview } = input;
  const canonical = canonicalSystemIds(overview.systems);
  const componentOfFile: Record<string, string> = {};
  const componentOfSystem: Record<string, string> = {};
  const byContainer: Record<string, C4Component[]> = {};
  const roleOwner = new Map<string, Map<CodeRole, string>>();
  const primaryByRaw = new Map<string, string>();
  const slugCounts = new Map<string, number>();

  for (const system of overview.systems) {
    const canonicalId = canonical.get(system.id) ?? system.id;
    const containerId = model.containerOfSystem[canonicalId];
    if (!containerId) continue;
    const slugKey = `${containerId}\0${systemSlug(canonicalId)}`;
    const slugPosition = (slugCounts.get(slugKey) ?? 0) + 1;
    slugCounts.set(slugKey, slugPosition);
    const slug = `${systemSlug(canonicalId)}${slugPosition > 1 ? `-${slugPosition}` : ""}`;
    const groups = system.groups ?? [];
    const ranked = [...groups].sort((a, b) => b.fileCount - a.fileCount || a.role.localeCompare(b.role));
    const substantial = groups.filter((g) => g.fileCount >= MIN_GROUP_FILES);
    const split = system.fileCount >= MIN_ROLE_SPLIT_FILES && substantial.length >= 2;
    const selected = split ? substantial : ranked.slice(0, 1);
    if (!selected.length) continue;
    const primaryGroup = [...selected].sort((a, b) => b.fileCount - a.fileCount || a.role.localeCompare(b.role))[0]!;
    const filesForRole = new Map<CodeRole, string[]>();
    const countForRole = new Map<CodeRole, number>();
    for (const group of groups) {
      const ownerRole = split && group.fileCount >= MIN_GROUP_FILES ? group.role : primaryGroup.role;
      filesForRole.set(ownerRole, [...(filesForRole.get(ownerRole) ?? []), ...group.files]);
      countForRole.set(ownerRole, (countForRole.get(ownerRole) ?? 0) + group.fileCount);
    }
    const owners = new Map<CodeRole, string>();
    const components: C4Component[] = [];
    for (const group of selected) {
      const files = [...new Set(filesForRole.get(group.role) ?? [])].sort();
      const id = `cmp:${containerId.replace(/^ctr:/, "")}/${slug}${split ? `.${group.role}` : ""}`;
      owners.set(group.role, id);
      const memberSet = new Set(files);
      const component: C4Component = {
        id,
        containerId,
        systemId: canonicalId,
        role: group.role,
        name: split ? `${system.name} ${COMPONENT_ROLE_LABELS[group.role].toLowerCase()}` : system.name,
        stereotype: COMPONENT_ROLE_LABELS[group.role],
        description: "",
        concern: system.concept,
        files: files.slice(0, COMPONENT_FILE_CAP),
        fileCount: countForRole.get(group.role) ?? files.length,
        ...((countForRole.get(group.role) ?? files.length) > COMPONENT_FILE_CAP ? { filesTruncated: true } : {}),
        interface: system.exports
          .filter((e) => memberSet.has(e.file))
          .sort((a, b) => b.consumers - a.consumers || a.name.localeCompare(b.name))
          .slice(0, COMPONENT_INTERFACE_CAP),
        interfaceTotal: system.exports.filter((e) => memberSet.has(e.file)).length,
        tech: system.libraries.slice(0, 4).map((l) => l.pkg),
        screenCount: (input.screens ?? []).filter((s) => memberSet.has(s.componentFile ?? s.file)).length,
        endpointCount: system.endpoints.filter((e) => memberSet.has(e.file)).length,
        entityCount: (input.schemas ?? []).filter((s) => memberSet.has(s.file)).length,
      };
      component.description = describeComponent(component);
      components.push(component);
      for (const file of component.files) componentOfFile[file] = id;
    }
    const primary = components.find((c) => c.role === primaryGroup.role)!;
    componentOfSystem[canonicalId] = primary.id;
    primaryByRaw.set(system.id, primary.id);
    for (const group of groups) if (!owners.has(group.role)) owners.set(group.role, primary.id);
    roleOwner.set(system.id, owners);
    byContainer[containerId] = [...(byContainer[containerId] ?? []), ...components];
  }

  for (const [containerId, components] of Object.entries(byContainer)) {
    byContainer[containerId] = components.sort((a, b) => {
      const af = isFrontendRole(a.role) ? "frontend" : "backend";
      const bf = isFrontendRole(b.role) ? "frontend" : "backend";
      return roleRank(a.role, af) - roleRank(b.role, bf) || b.fileCount - a.fileCount || a.id.localeCompare(b.id);
    });
  }

  const edgeMap = new Map<string, C4ComponentEdge>();
  const addEdge = (
    source: string | undefined,
    target: string | undefined,
    kind: C4ComponentEdge["kind"],
    weight: number,
    symbols?: string[],
  ) => {
    if (!source || !target || source === target || weight <= 0) return;
    const key = `${source}\0${target}\0${kind}`;
    const old = edgeMap.get(key);
    if (old) {
      old.weight += weight;
      old.symbols = [...new Set([...(old.symbols ?? []), ...(symbols ?? [])])].slice(0, 4);
    } else {
      edgeMap.set(key, {
        source,
        target,
        kind,
        weight,
        ...(symbols?.length ? { symbols: symbols.slice(0, 4) } : {}),
      });
    }
  };
  for (const system of overview.systems) {
    const owners = roleOwner.get(system.id);
    for (const link of system.groupLinks ?? []) {
      addEdge(owners?.get(link.source), owners?.get(link.target), "imports", link.weight);
    }
  }
  for (const link of overview.links) {
    if (link.groups?.length) {
      for (const group of link.groups) {
        addEdge(
          roleOwner.get(link.source)?.get(group.sourceGroup),
          roleOwner.get(link.target)?.get(group.targetGroup),
          "imports",
          group.weight,
          link.symbols,
        );
      }
    } else {
      addEdge(
        primaryByRaw.get(link.source),
        primaryByRaw.get(link.target),
        "imports",
        link.weight,
        link.symbols,
      );
    }
    addEdge(
      primaryByRaw.get(link.source),
      primaryByRaw.get(link.target),
      "api",
      (link.apis ?? []).reduce((n, api) => n + api.weight, 0),
    );
  }
  return {
    byContainer,
    componentOfFile,
    componentOfSystem,
    edges: [...edgeMap.values()].sort((a, b) =>
      a.source.localeCompare(b.source) ||
      a.target.localeCompare(b.target) ||
      a.kind.localeCompare(b.kind)),
  };
}

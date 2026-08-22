import { canonicalSystemIds } from "./arch-derive.js";
import { ArchOverlaySchema, type ArchOverlay } from "./arch-overlay.js";
import type {
  ArchEdge,
  ArchFacet,
  ArchNode,
  ArchitectureGraph,
  Journey,
} from "./architecture.js";
import { createLocalEnvironment } from "./architecture.js";
import { normalizeOverlayDeployTargets } from "./arch-deploy.js";
import type { SystemOverview } from "./system-overview.js";
import type { SystemsLayout } from "./systems-layout.js";

/**
 * One-time lossless migration of the legacy per-diagram world into the
 * canonical-architecture overlay. Runs server-side on the first
 * `arch.getOverlay` when no overlay file exists yet; the legacy files are
 * READ, never rewritten or deleted.
 *
 *  - `systems-layout.json` → manual `group` container nodes for the user's
 *    system groups, member systems re-parented into them.
 *  - each `.crystal/architecture/*.crystal` diagram → one facet named after
 *    the diagram (`sourcePath` lets old `?diagram=` links resolve); nodes
 *    that match a derived system become overrides on its canonical id,
 *    everything else (queues, buckets, notes…) becomes a manual node; edges
 *    the derivation doesn't draw become manual edges; environments,
 *    placements, journeys and per-diagram facets carry over.
 *
 * Positions deliberately do NOT migrate for derived systems: every legacy
 * canvas had its own coordinate space, and pinning foreign coordinates under
 * the new auto-layout produces a jumble — the semantics (grouping, accents,
 * sim configs, placements) are what the user authored; the layout re-derives
 * cleanly. Manual nodes keep their own stored positions (few, easy to drag).
 * Only the FIRST diagram contributes overrides for matched systems; later
 * diagrams still contribute their facet, manual nodes and journeys.
 */
/**
 * Facet id a diagram/survey file migrates into — deterministic so importers
 * can deep-link to the facet without re-reading the overlay.
 */
export const diagramFacetId = (path: string): string => `facet:diagram:${path}`;

export function migrateLegacyToOverlay(input: {
  diagrams: readonly { path: string; graph: ArchitectureGraph }[];
  layout: SystemsLayout | null;
  overview: SystemOverview;
}): ArchOverlay {
  const { diagrams, layout, overview } = input;
  const idOfRaw = canonicalSystemIds(overview.systems);
  const canonicalIds = new Set(idOfRaw.values());

  const overlay = ArchOverlaySchema.parse({});
  const manualById = new Map<string, ArchNode>();
  const manualEdgeIds = new Set<string>();
  const journeys: Journey[] = [];
  const journeyIds = new Set<string>();
  const facets: ArchFacet[] = [];
  const environments: ArchitectureGraph["environments"] = [];
  const envByName = new Map<string, string>();

  /** Match a legacy diagram node onto a derived system's canonical id. */
  const slugOf = (value: string): string =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  const matchSystem = (node: ArchNode): string | null => {
    if (node.codeModule) {
      // Deepest part (by path prefix) owning the node's code link — the same
      // rule the derivation uses for external-service attribution.
      let best: { id: string; len: number } | null = null;
      for (const s of overview.systems) {
        for (const p of s.parts) {
          for (const candidate of [p.path, p.pkg]) {
            const owns =
              node.codeModule === candidate || node.codeModule.startsWith(`${candidate}/`);
            if (!owns) continue;
            if (!best || candidate.length > best.len)
              best = { id: idOfRaw.get(s.id) ?? s.id, len: candidate.length };
          }
        }
      }
      if (best) return best.id;
    }
    // Ids derive from concepts ("sys:auth"), labels from display names
    // ("Authentication") — try both.
    const labelSlug = slugOf(node.label);
    for (const s of overview.systems) {
      if (s.id === `sys:${labelSlug}` || slugOf(s.name) === labelSlug)
        return idOfRaw.get(s.id) ?? s.id;
    }
    return canonicalIds.has(`sys:${labelSlug}`) ? `sys:${labelSlug}` : null;
  };

  /* ---- systems layout: the user's groups (positions stay behind) ---- */
  if (layout) {
    for (const group of layout.groups) {
      manualById.set(group.id, {
        id: group.id,
        kind: "group",
        label: group.name,
        description: "",
        parentId: null,
        position: { x: 0, y: 0 },
        size: { width: 420, height: 280 },
        tech: [],
        placements: {},
      });
    }
    for (const group of layout.groups) {
      for (const member of group.members) {
        if (!canonicalIds.has(member)) continue; // stale system id — inert, skip
        overlay.overrides[member] = { ...overlay.overrides[member], parentId: group.id };
      }
    }
  }

  /* ---- legacy diagrams ---- */
  diagrams.forEach(({ path, graph }, index) => {
    const idMap = new Map<string, string>(); // legacy node id → overlay id
    for (const node of graph.nodes) {
      const sys = matchSystem(node);
      if (sys) {
        idMap.set(node.id, sys);
        if (index === 0) {
          const o = overlay.overrides[sys] ?? {};
          if (node.accent) o.accent = node.accent;
          if (node.sim) o.sim = node.sim;
          if (node.href) o.href = node.href;
          if (Object.keys(node.placements).length > 0)
            o.placements = { ...node.placements, ...o.placements };
          if (Object.keys(o).length > 0) overlay.overrides[sys] = o;
        }
        continue;
      }
      // Unmatched — a genuinely manual node. Keep its id (facet members and
      // edges reference it); collide across diagrams → first one wins.
      idMap.set(node.id, node.id);
      if (!manualById.has(node.id)) {
        // Parents may re-map (a container that matched a system); resolved below.
        manualById.set(node.id, { ...node });
      }
    }
    // Re-point manual nodes' parents through the id map.
    for (const node of graph.nodes) {
      const manual = manualById.get(idMap.get(node.id) ?? "");
      if (manual && node.parentId) manual.parentId = idMap.get(node.parentId) ?? null;
    }
    for (const edge of graph.edges) {
      const source = idMap.get(edge.source);
      const target = idMap.get(edge.target);
      if (!source || !target) continue;
      const mapped: ArchEdge = { ...edge, id: `${edge.id}`, source, target };
      if (manualEdgeIds.has(mapped.id)) continue;
      manualEdgeIds.add(mapped.id);
      overlay.manualEdges.push(mapped);
    }
    for (const env of graph.environments) {
      // Environments merge by name across diagrams; placements were keyed by
      // env id per diagram, so remap placements onto the surviving env id.
      const existing = envByName.get(env.name.toLowerCase());
      if (!existing) {
        envByName.set(env.name.toLowerCase(), env.id);
        environments.push(env);
      } else if (existing !== env.id) {
        const remap = (placements: Record<string, unknown>) => {
          if (placements[env.id] != null && placements[existing] == null) {
            placements[existing] = placements[env.id];
            delete placements[env.id];
          }
        };
        for (const o of Object.values(overlay.overrides)) {
          if (o.placements) remap(o.placements as Record<string, unknown>);
        }
        for (const n of manualById.values()) remap(n.placements as Record<string, unknown>);
      }
    }
    for (const j of graph.journeys) {
      if (journeyIds.has(j.id)) continue;
      journeyIds.add(j.id);
      journeys.push(j);
    }
    // The diagram itself becomes a facet over its (mapped) members. An empty
    // diagram (the auto-seeded blank "Overview") would be a show-everything
    // facet — pure noise, skip it.
    if (graph.nodes.length > 0) {
      facets.push({
        id: diagramFacetId(path),
        name: graph.name || path.split("/").pop() || path,
        description: graph.description ?? "",
        nodeIds: graph.nodes.map((n) => idMap.get(n.id)!).filter(Boolean),
        sourcePath: path,
      });
    }
    // …and its own facets carry over with mapped members.
    for (const f of graph.facets) {
      facets.push({
        ...f,
        nodeIds: f.nodeIds.map((id) => idMap.get(id) ?? id),
        sourcePath: null,
      });
    }
  });

  overlay.manualNodes = [...manualById.values()];
  overlay.environments = environments.length > 0 ? environments : [createLocalEnvironment()];
  overlay.journeys = journeys;
  overlay.facets = facets;
  return ArchOverlaySchema.parse(normalizeOverlayDeployTargets(overlay));
}

/**
 * Merge one standalone diagram (an agent survey import, a shared `.crystal`
 * file) into an existing overlay: same matching rules as the migration, but
 * the user's current overlay always wins on conflict, and re-importing the
 * same `path` replaces its facet instead of stacking duplicates.
 */
export function mergeDiagramIntoOverlay(
  overlay: ArchOverlay,
  diagram: { path: string; graph: ArchitectureGraph },
  overview: SystemOverview,
): ArchOverlay {
  const m = migrateLegacyToOverlay({ diagrams: [diagram], layout: null, overview });
  const manualIds = new Set(overlay.manualNodes.map((n) => n.id));
  const manualEdgeIds = new Set(overlay.manualEdges.map((e) => e.id));
  const envNames = new Set(overlay.environments.map((e) => e.name.toLowerCase()));
  const journeyIds = new Set(overlay.journeys.map((j) => j.id));
  const facetIds = new Set(overlay.facets.map((f) => f.id));
  return ArchOverlaySchema.parse(normalizeOverlayDeployTargets({
    ...overlay,
    overrides: { ...m.overrides, ...overlay.overrides },
    manualNodes: [
      ...overlay.manualNodes,
      ...m.manualNodes.filter((n) => !manualIds.has(n.id)),
    ],
    manualEdges: [
      ...overlay.manualEdges,
      ...m.manualEdges.filter((e) => !manualEdgeIds.has(e.id)),
    ],
    environments: [
      ...overlay.environments,
      ...m.environments.filter((e) => !envNames.has(e.name.toLowerCase())),
    ],
    journeys: [...overlay.journeys, ...m.journeys.filter((j) => !journeyIds.has(j.id))],
    facets: [
      ...overlay.facets.filter((f) => f.sourcePath !== diagram.path),
      ...m.facets.filter((f) => f.sourcePath === diagram.path || !facetIds.has(f.id)),
    ],
  }));
}

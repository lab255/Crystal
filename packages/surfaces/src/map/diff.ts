import {
  diffSystemOverviews,
  endpointKey,
  isFixtureScopedPath,
  type ScreenApiCall,
  type ScreenSurface,
  type SystemEndpoint,
  type SystemLink,
  type SystemModule,
} from "@crystal/core";
import {
  makeSystemAttributor,
  screenNodeId,
  type MapDiffMark,
  type SystemMapLayoutInput,
  type SystemMapMarks,
} from "./scene.js";

/**
 * System-map ref review — diff the live map inputs against a `surfaces.atRef`
 * snapshot. Pure: `(base, head)` in, marks + ghost-merged inputs + a review
 * list out. The merged inputs feed `buildSystemMapLayout` (so removed
 * screens/systems/links/flows render as ghosts) and the marks feed
 * `decorateSystemMapScene` (green added / red removed / yellow modified).
 */

export interface MapDiffEntry {
  /** Stable row key — also the canvas→panel highlight handle. */
  key: string;
  /** Review-panel section this entry lists under. */
  section: string;
  mark: MapDiffMark;
  label: string;
  detail?: string;
  /** Canvas node the row focuses when clicked (and matches for highlight). */
  nodeId?: string;
  /** Canvas edge this change draws as, when it is an edge change. */
  edgeId?: string;
}

export interface SystemMapDiff {
  marks: SystemMapMarks;
  entries: MapDiffEntry[];
  /** Head + ghosts of everything the ref had — what the canvas lays out. */
  merged: SystemMapLayoutInput;
  total: number;
}

interface FlowAgg {
  screenId: string;
  sysId: string;
  count: number;
  epKeys: Set<string>;
  calls: ScreenApiCall[];
}

/**
 * Screen→system call flows of one side, aggregated exactly like the scene's
 * edge builder (fixture scoping, longest-prefix attribution, own-system calls
 * skipped) so flow keys line up with `call:` edge ids.
 */
function flowsOf(input: SystemMapLayoutInput): Map<string, FlowAgg> {
  const systems = input.overview.systems.filter(
    (s) => !s.parts.every((p) => isFixtureScopedPath(p.path)),
  );
  const screens = input.report.screens.filter((s) => !isFixtureScopedPath(s.file));
  const screenIds = new Set(screens.map((s) => s.id));
  const sysOfFile = makeSystemAttributor(systems);
  const ownerOf = new Map<string, string>();
  for (const s of screens) {
    const owner = sysOfFile(s.file);
    if (owner && owner.layer === "frontend") ownerOf.set(s.id, owner.id);
  }
  const flows = new Map<string, FlowAgg>();
  for (const c of input.calls) {
    if (!c.endpoint || !screenIds.has(c.screen)) continue;
    const target = sysOfFile(c.endpoint.file);
    if (!target || ownerOf.get(c.screen) === target.id) continue;
    const key = `${screenNodeId(c.screen)}->${target.id}`;
    const agg =
      flows.get(key) ??
      ({ screenId: c.screen, sysId: target.id, count: 0, epKeys: new Set(), calls: [] } as FlowAgg);
    agg.count += 1;
    agg.epKeys.add(endpointKey(c.endpoint));
    agg.calls.push(c);
    flows.set(key, agg);
  }
  return flows;
}

const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean =>
  a.size === b.size && [...a].every((x) => b.has(x));

export function diffSystemMap(
  base: SystemMapLayoutInput,
  head: SystemMapLayoutInput,
): SystemMapDiff {
  const nodeMarks = new Map<string, MapDiffMark>();
  const edgeMarks = new Map<string, MapDiffMark>();
  const epMarks = new Map<string, MapDiffMark>();
  const entries: MapDiffEntry[] = [];

  /* ---- screens (by ScreenSurface.id — a route change is add + remove) ---- */
  const baseScreens = new Map(base.report.screens.map((s) => [s.id, s]));
  const headScreens = new Map(head.report.screens.map((s) => [s.id, s]));
  const ghostScreens: ScreenSurface[] = [];
  for (const [id, s] of headScreens) {
    const b = baseScreens.get(id);
    const nodeId = screenNodeId(id);
    if (!b) {
      nodeMarks.set(nodeId, "added");
      entries.push({ key: `screen+${id}`, section: "New screens", mark: "added", label: s.route, detail: s.file, nodeId });
    } else if (b.file !== s.file || (b.component ?? null) !== (s.component ?? null)) {
      nodeMarks.set(nodeId, "modified");
      entries.push({
        key: `screen~${id}`,
        section: "Changed screens",
        mark: "modified",
        label: s.route,
        detail:
          b.file !== s.file
            ? `${b.file} → ${s.file}`
            : `${b.component ?? "(none)"} → ${s.component ?? "(none)"}`,
        nodeId,
      });
    }
  }
  for (const [id, s] of baseScreens) {
    if (headScreens.has(id)) continue;
    ghostScreens.push(s);
    const nodeId = screenNodeId(id);
    nodeMarks.set(nodeId, "removed");
    entries.push({ key: `screen-${id}`, section: "Removed screens", mark: "removed", label: s.route, detail: s.file, nodeId });
  }

  /* ---- systems + system links (the overview's own diff) ---- */
  const od = diffSystemOverviews(base.overview, head.overview);
  const baseSystemsById = new Map(base.overview.systems.map((s) => [s.id, s]));
  const headSystemsById = new Map(head.overview.systems.map((s) => [s.id, s]));
  for (const s of od.addedSystems) {
    nodeMarks.set(s.id, "added");
    entries.push({ key: `sys+${s.id}`, section: "New systems", mark: "added", label: s.name, detail: `${s.role} · ${s.fileCount} files`, nodeId: s.id });
  }
  const ghostSystems: SystemModule[] = [];
  for (const s of od.removedSystems) {
    const orig = baseSystemsById.get(s.id);
    if (orig) ghostSystems.push(orig);
    nodeMarks.set(s.id, "removed");
    entries.push({ key: `sys-${s.id}`, section: "Removed systems", mark: "removed", label: s.name, detail: `${s.role} · was ${s.fileCount} files`, nodeId: s.id });
  }
  for (const s of od.resized) {
    if (nodeMarks.has(s.id)) continue;
    nodeMarks.set(s.id, "modified");
    entries.push({ key: `sys~${s.id}`, section: "Changed systems", mark: "modified", label: s.name, detail: `${s.before} → ${s.after} files`, nodeId: s.id });
  }

  // System→system link changes mark whichever edge the scene draws for the
  // pair — plain `link:` between backend systems or the `feapi:` fallback.
  const markLink = (source: string, target: string, mark: MapDiffMark): string => {
    edgeMarks.set(`link:${source}->${target}`, mark);
    edgeMarks.set(`feapi:${source}->${target}`, mark);
    return `link:${source}->${target}`;
  };
  const nameOfSys = (id: string): string =>
    headSystemsById.get(id)?.name ?? baseSystemsById.get(id)?.name ?? id;
  const baseLinkByKey = new Map(base.overview.links.map((l) => [`${l.source}->${l.target}`, l]));
  const ghostLinks: SystemLink[] = [];
  for (const l of od.addedLinks) {
    const edgeId = markLink(l.source, l.target, "added");
    entries.push({
      key: `link+${l.source}->${l.target}`,
      section: "New links",
      mark: "added",
      label: `${l.sourceName} → ${l.targetName}`,
      detail: l.symbols.join(", ") || `×${l.weight}`,
      nodeId: l.source,
      edgeId,
    });
  }
  for (const l of od.removedLinks) {
    const orig = baseLinkByKey.get(`${l.source}->${l.target}`);
    if (orig) ghostLinks.push(orig);
    const edgeId = markLink(l.source, l.target, "removed");
    entries.push({
      key: `link-${l.source}->${l.target}`,
      section: "Dropped links",
      mark: "removed",
      label: `${l.sourceName} → ${l.targetName}`,
      detail: l.symbols.join(", ") || `×${l.weight}`,
      nodeId: l.source,
      edgeId,
    });
  }
  for (const l of od.reweighted) {
    const edgeId = markLink(l.source, l.target, "modified");
    entries.push({
      key: `link~${l.source}->${l.target}`,
      section: "Changed links",
      mark: "modified",
      label: `${l.sourceName} → ${l.targetName}`,
      detail: `×${l.before} → ×${l.after}`,
      nodeId: l.source,
      edgeId,
    });
  }

  /* ---- endpoints per surviving system (rows on the cards) ---- */
  const extraEndpoints = new Map<string, SystemEndpoint[]>();
  for (const [id, hs] of headSystemsById) {
    const bs = baseSystemsById.get(id);
    if (!bs) continue; // whole-system add already reads green
    const bByKey = new Map(bs.endpoints.map((e) => [endpointKey(e), e]));
    const hKeys = new Set(hs.endpoints.map((e) => endpointKey(e)));
    let touched = false;
    for (const k of hKeys) {
      if (bByKey.has(k)) continue;
      touched = true;
      epMarks.set(`${id}|${k}`, "added");
      entries.push({ key: `ep+${id}|${k}`, section: "New endpoints", mark: "added", label: k, detail: hs.name, nodeId: id });
    }
    for (const [k, e] of bByKey) {
      if (hKeys.has(k)) continue;
      touched = true;
      epMarks.set(`${id}|${k}`, "removed");
      const extra = extraEndpoints.get(id) ?? [];
      extra.push(e);
      extraEndpoints.set(id, extra);
      entries.push({ key: `ep-${id}|${k}`, section: "Removed endpoints", mark: "removed", label: k, detail: hs.name, nodeId: id });
    }
    if (touched && !nodeMarks.has(id)) nodeMarks.set(id, "modified");
  }

  /* ---- screen→system call flows ---- */
  const baseFlows = flowsOf(base);
  const headFlows = flowsOf(head);
  const ghostCalls: ScreenApiCall[] = [];
  const routeOf = (screenId: string): string =>
    headScreens.get(screenId)?.route ?? baseScreens.get(screenId)?.route ?? screenId;
  for (const [key, f] of headFlows) {
    const b = baseFlows.get(key);
    const edgeId = `call:${key}`;
    const label = `${routeOf(f.screenId)} → ${nameOfSys(f.sysId)}`;
    if (!b) {
      edgeMarks.set(edgeId, "added");
      entries.push({
        key: `flow+${key}`,
        section: "New call flows",
        mark: "added",
        label,
        detail: `${f.count} call${f.count === 1 ? "" : "s"}`,
        nodeId: screenNodeId(f.screenId),
        edgeId,
      });
    } else if (b.count !== f.count || !sameSet(b.epKeys, f.epKeys)) {
      edgeMarks.set(edgeId, "modified");
      entries.push({
        key: `flow~${key}`,
        section: "Changed call flows",
        mark: "modified",
        label,
        detail: `${b.count} → ${f.count} call${f.count === 1 ? "" : "s"}`,
        nodeId: screenNodeId(f.screenId),
        edgeId,
      });
    }
  }
  for (const [key, f] of baseFlows) {
    if (headFlows.has(key)) continue;
    const edgeId = `call:${key}`;
    edgeMarks.set(edgeId, "removed");
    // Ghost calls re-draw the dropped flow; the merged canvas has both ends
    // (the screen/system survives, or rides in as its own ghost).
    ghostCalls.push(...f.calls);
    entries.push({
      key: `flow-${key}`,
      section: "Dropped call flows",
      mark: "removed",
      label: `${routeOf(f.screenId)} → ${nameOfSys(f.sysId)}`,
      detail: `was ${f.count} call${f.count === 1 ? "" : "s"}`,
      nodeId: screenNodeId(f.screenId),
      edgeId,
    });
  }

  /* ---- merged canvas inputs: head + ghosts of what the ref had ---- */
  const mergedSystems = head.overview.systems.map((s) => {
    const extra = extraEndpoints.get(s.id);
    return extra ? { ...s, endpoints: [...s.endpoints, ...extra] } : s;
  });
  const merged: SystemMapLayoutInput = {
    report: { ...head.report, screens: [...head.report.screens, ...ghostScreens] },
    overview: {
      ...head.overview,
      systems: [...mergedSystems, ...ghostSystems],
      links: [...head.overview.links, ...ghostLinks],
    },
    calls: [...head.calls, ...ghostCalls],
  };

  return {
    marks: { node: nodeMarks, edge: edgeMarks, ep: epMarks },
    entries,
    merged,
    total: entries.length,
  };
}

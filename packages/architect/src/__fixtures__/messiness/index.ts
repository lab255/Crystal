import {
  createArchNode,
  createArchitectureGraph,
  type ArchEdge,
  type ArchNode,
  type ArchitectureGraph,
} from "@crystal/core";

export interface MessinessFixture {
  graph: ArchitectureGraph;
  dims: ReadonlyMap<string, { width: number; height: number }>;
  pinBrokenRoutes?: number;
}

function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function node(id: string, parentId?: string): ArchNode {
  return {
    ...createArchNode(parentId ? "service" : "system", id, { x: 0, y: 0 }),
    id,
    ...(parentId ? { parentId } : {}),
  };
}

function edge(id: string, source: string, target: string, label = "calls"): ArchEdge {
  return { id, source, target, kind: "dependency", label };
}

function fixture(name: string, nodes: ArchNode[], edges: ArchEdge[], pinBrokenRoutes = 0): MessinessFixture {
  return {
    graph: { ...createArchitectureGraph(name), id: `messiness:${name}`, nodes, edges },
    dims: new Map(nodes.filter((item) => item.kind !== "system").map((item, index) => [
      item.id,
      { width: 176 + (index % 3) * 16, height: 76 + (index % 2) * 12 },
    ])),
    ...(pinBrokenRoutes ? { pinBrokenRoutes } : {}),
  };
}

export function cleanTreeFixture(): MessinessFixture {
  const nodes = Array.from({ length: 8 }, (_, index) => node(`clean:${index}`));
  const edges = Array.from({ length: 7 }, (_, index) =>
    edge(`clean:e${index}`, `clean:${Math.floor(index / 2)}`, `clean:${index + 1}`, ""));
  return fixture("clean-tree", nodes, edges);
}

export function mediumLayeredFixture(): MessinessFixture {
  const nodes = Array.from({ length: 30 }, (_, index) => node(`medium:${index}`));
  const edges: ArchEdge[] = [];
  for (let layer = 0; layer < 4; layer += 1) {
    for (let column = 0; column < 6; column += 1) {
      const source = layer * 6 + column;
      for (let targetColumn = 0; targetColumn < 6; targetColumn += 1) {
        if ((column + targetColumn + layer) % 2 === 0) {
          edges.push(edge(`medium:e${edges.length}`, `medium:${source}`, `medium:${(layer + 1) * 6 + targetColumn}`, "publishes events"));
        }
      }
    }
  }
  return fixture("medium-layered", nodes, edges);
}

export function denseTangleFixture(): MessinessFixture {
  const random = seeded(0xc7a57a1);
  // Prefixes model five source scopes while keeping the graph flat, as a
  // saved overview does after its scope projection is expanded.
  const members = Array.from({ length: 80 }, (_, index) => node(`tangle:scope${index % 5}:${index}`));
  const edges: ArchEdge[] = [];
  const seen = new Set<string>();
  while (edges.length < 130) {
    const source = Math.floor(random() * members.length);
    let target = Math.floor(random() * members.length);
    if (target === source) target = (target + 17) % members.length;
    // Bias toward cross-scope, long-rank traffic.
    if (source % 5 === target % 5) target = (target + 1) % members.length;
    const key = `${source}:${target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push(edge(`tangle:e${edges.length}`, members[source]!.id, members[target]!.id, `contract ${edges.length % 23}`));
  }
  // A tight parallel contract bundle exercises the independent label-overlap
  // signal without manufacturing metrics outside the real ELK solve.
  for (let index = 0; index < 15; index += 1) {
    edges.push(edge(`tangle:e${edges.length}`, members[0]!.id, members[79]!.id, `shared contract ${index}`));
  }
  return fixture("dense-tangle", members, edges);
}

export function overlappingLabelsFixture(): MessinessFixture {
  const sources = Array.from({ length: 6 }, (_, index) => node(`labels:source:${index}`));
  const targets = Array.from({ length: 6 }, (_, index) => node(`labels:target:${index}`));
  const edges = sources.flatMap((source, sourceIndex) => targets.map((target, targetIndex) =>
    edge(
      `labels:e${sourceIndex}:${targetIndex}`,
      source.id,
      target.id,
      `dense parallel labeled contract ${sourceIndex}-${targetIndex} ${"constraint ".repeat(18)}`,
    )));
  const built = fixture("overlapping-labels", [...sources, ...targets], edges);
  return {
    ...built,
    dims: new Map([...sources, ...targets].map((item) => [item.id, { width: 72, height: 36 }])),
  };
}

export function extremeAspectFixture(): MessinessFixture {
  const scope = node("aspect:scope");
  const members = Array.from({ length: 7 }, (_, index) => node(`aspect:${index}`, scope.id));
  const edges = members.slice(1).map((member, index) =>
    edge(`aspect:e${index}`, members[0]!.id, member.id, ""));
  return fixture("extreme-aspect", [scope, ...members], edges);
}

export function pinnedBrokenFixture(): MessinessFixture {
  const dense = denseTangleFixture();
  return { ...dense, graph: { ...dense.graph, id: "messiness:pinned-broken", name: "pinned-broken" }, pinBrokenRoutes: 60 };
}

export const messinessFixtures = {
  clean: cleanTreeFixture,
  medium: mediumLayeredFixture,
  tangle: denseTangleFixture,
  pinnedBroken: pinnedBrokenFixture,
  overlappingLabels: overlappingLabelsFixture,
  extremeAspect: extremeAspectFixture,
} as const;

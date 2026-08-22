import { describe, expect, it } from "vitest";
import {
  createArchNode,
  createArchitectureGraph,
  type ArchNode,
  type ArchitectureGraph,
  type C4View,
} from "@crystal/core";
import { exportMermaidC4, exportMermaidC4Deployment, sanitizeMermaidId } from "./export-mermaid.js";

function node(id: string, patch: Partial<ArchNode> = {}): ArchNode {
  return {
    ...createArchNode("service", id, { x: 0, y: 0 }),
    id,
    label: id,
    ...patch,
  };
}

function projection(
  nodes: ArchNode[],
  view: C4View,
  typeLines: Record<string, string> = {},
  edges: ArchitectureGraph["edges"] = [],
) {
  return {
    graph: { ...createArchitectureGraph("Checkout"), nodes, edges },
    typeLines,
    view,
  };
}

describe("exportMermaidC4", () => {
  it("sanitizes aliases and deterministically disambiguates collisions", () => {
    expect(sanitizeMermaidId("9 api/edge:v1")).toBe("_9_api_edge_v1");
    const output = exportMermaidC4(
      projection(
        [node("api-a"), node("api_a"), node("api_a_2")],
        { level: "components", scope: "ctr:api" },
      ),
    );
    expect(output).toContain('Component(api_a, "api-a", "", "")');
    expect(output).toContain('Component(api_a_2, "api_a", "", "")');
    expect(output).toContain('Component(api_a_2_2, "api_a_2", "", "")');
  });

  it("maps people, systems, external systems, containers, and components", () => {
    const output = exportMermaidC4(
      projection(
        [
          node("person:user", { kind: "person", label: "User" }),
          node("sys:checkout", { kind: "system", label: "Checkout" }),
          node("ext:stripe", { kind: "external", label: "Stripe", description: "Payments" }),
          node("ctr:web", {
            kind: "container",
            label: "Web app",
            description: "Customer UI",
            tech: ["React"],
          }),
          node("cmp:cart", { label: "Cart", tech: ["TypeScript"], description: "Cart logic" }),
        ],
        { level: "context" },
        {
          "person:user": "Person",
          "sys:checkout": "Software System",
          "ext:stripe": "External System · payments",
          "ctr:web": "Container · Web application",
          "cmp:cart": "Component",
        },
      ),
    );
    expect(output).toContain('Person(person_user, "User")');
    expect(output).toContain('System(sys_checkout, "Checkout", "")');
    expect(output).toContain('System_Ext(ext_stripe, "Stripe", "Payments")');
    expect(output).toContain(
      'Container(ctr_web, "Web app", "Web application", "Customer UI")',
    );
    expect(output).toContain('Component(cmp_cart, "Cart", "TypeScript", "Cart logic")');
  });

  it("nests declarations inside system and container boundaries", () => {
    const containers = exportMermaidC4(
      projection(
        [
          node("c4:system", { kind: "system", label: "Checkout" }),
          node("ctr:api", { kind: "container", label: "API", parentId: "c4:system" }),
        ],
        { level: "containers" },
        { "c4:system": "Software System", "ctr:api": "Container · Server application" },
      ),
    );
    expect(containers).toContain(
      'System_Boundary(c4_system, "Checkout") {\n  Container(ctr_api, "API", "Server application", "")\n}',
    );

    const components = exportMermaidC4(
      projection(
        [
          node("ctr:api", { kind: "system", label: "API" }),
          node("cmp:orders", { label: "Orders", parentId: "ctr:api" }),
        ],
        { level: "components", scope: "ctr:api" },
        { "ctr:api": "Container · Server application", "cmp:orders": "Component" },
      ),
    );
    expect(components).toContain(
      'Container_Boundary(ctr_api, "API") {\n  Component(cmp_orders, "Orders", "", "")\n}',
    );
  });

  it("preserves aggregated relationship labels", () => {
    const output = exportMermaidC4(
      projection(
        [node("ctr:web", { kind: "container" }), node("ext:stripe", { kind: "external" })],
        { level: "containers" },
        {},
        [
          {
            id: "c4rel:ctr:web->ext:stripe",
            source: "ctr:web",
            target: "ext:stripe",
            kind: "sync",
            label: "Takes payment via ×3",
          },
        ],
      ),
    );
    expect(output).toContain(
      'Rel(ctr_web, ext_stripe, "Takes payment via ×3")',
    );
  });

  it("sorts declarations and relationships by id regardless of input order", () => {
    const a = node("a");
    const z = node("z");
    const edgeA = { id: "a-edge", source: "a", target: "z", kind: "sync" as const, label: "A" };
    const edgeZ = { id: "z-edge", source: "z", target: "a", kind: "sync" as const, label: "Z" };
    const forward = exportMermaidC4(
      projection([z, a], { level: "components", scope: "ctr:x" }, {}, [edgeZ, edgeA]),
    );
    const reversed = exportMermaidC4(
      projection([a, z], { level: "components", scope: "ctr:x" }, {}, [edgeA, edgeZ]),
    );
    expect(forward).toBe(reversed);
    expect(forward.indexOf("Component(a,")).toBeLessThan(forward.indexOf("Component(z,"));
    expect(forward.indexOf('Rel(a, z, "A")')).toBeLessThan(
      forward.indexOf('Rel(z, a, "Z")'),
    );
  });
});

describe("exportMermaidC4Deployment", () => {
  it("emits stable nested deployment boundaries and placed relationships", () => {
    const region = { ...createArchNode("region", "Singapore", { x: 10, y: 20 }), id: "zone:sg" };
    const api = { ...createArchNode("service", "API", { x: 0, y: 0 }), id: "svc:api", tech: ["Node.js"], description: "HTTP API", placements: { prod: { targetId: "tgt:ecs", target: "ECS", runtime: "fargate" } } };
    const db = { ...createArchNode("datastore", "DB", { x: 0, y: 0 }), id: "svc:db", tech: ["Postgres"], description: "Primary", placements: { prod: { targetId: "tgt:rds", target: "RDS", runtime: "" } } };
    const graph = { ...createArchitectureGraph("Payments"), environments: [{ id: "prod", name: "Production", kind: "cloud" as const, targets: [{ id: "tgt:ecs", name: "ECS", kind: "compute" as const, tech: "Fargate", region: "ap-southeast-1", zone: "zone:sg" }, { id: "tgt:rds", name: "RDS", kind: "compute" as const, zone: "missing" }] }], nodes: [db, region, api], edges: [{ id: "edge:z", source: "svc:api", target: "svc:db", kind: "data" as const, label: "reads" }] };
    expect(exportMermaidC4Deployment(graph, "prod")).toBe(`C4Deployment
title Payments — Production

Deployment_Node(prod, "Production", "cloud") {
  Deployment_Node(zone_sg, "Singapore", "region") {
    Deployment_Node(tgt_ecs, "ECS", "Fargate · ap-southeast-1") {
      Container(svc_api, "API", "Node.js", "HTTP API")
    }
  }
  Deployment_Node(tgt_rds, "RDS", "") {
    Container(svc_db, "DB", "Postgres", "Primary")
  }
}

Rel(svc_api, svc_db, "reads")
`);
  });

  it("renders dangling target ids in the same synthesized fallback group as the canvas", () => {
    const api = { ...createArchNode("service", "API", { x: 0, y: 0 }), id: "api", placements: { prod: { targetId: "gone", target: "", runtime: "" } } };
    const graph = { ...createArchitectureGraph("App"), environments: [{ id: "prod", name: "Prod", kind: "cloud" as const, targets: [] }], nodes: [api] };
    const mermaid = exportMermaidC4Deployment(graph, "prod");
    expect(mermaid).toContain('Deployment_Node(gone, "Unknown target", "")');
    expect(mermaid).toContain('Container(api, "API"');
  });

  it("allocates distinct deterministic aliases when sanitized deployment ids collide", () => {
    const a = { ...createArchNode("service", "A", { x: 0, y: 0 }), id: "svc:a", placements: { prod: { targetId: "target:a", target: "A", runtime: "" } } };
    const b = { ...createArchNode("service", "B", { x: 0, y: 0 }), id: "svc-a", placements: { prod: { targetId: "target-a", target: "B", runtime: "" } } };
    const graph = { ...createArchitectureGraph("App"), environments: [{ id: "prod", name: "Prod", kind: "cloud" as const, targets: [{ id: "target:a", name: "A", kind: "other" as const }, { id: "target-a", name: "B", kind: "other" as const }] }], nodes: [a, b] };
    const mermaid = exportMermaidC4Deployment(graph, "prod");
    expect(mermaid).toContain('Deployment_Node(target_a, "B"');
    expect(mermaid).toContain('Deployment_Node(target_a_2, "A"');
    expect(mermaid).toContain('Container(svc_a, "B"');
    expect(mermaid).toContain('Container(svc_a_2, "A"');
  });
});

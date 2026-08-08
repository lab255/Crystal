import { describe, expect, it } from "vitest";
import type { CodeFileDetail, CodeModuleDetail } from "@crystal/core";
import {
  ARCH_CODE_HEADER_H,
  CODE_LOADING_SIZE,
  EDGE_FULL_LIMIT,
  LIVE_FILE_CAP,
  buildCodeContent,
  overflowChipId,
  unifiedDropTargetAt,
  type CodeContentInput,
  type HitTestNode,
} from "./live-code.js";
import { MODULE_PAD, fileId } from "./codemap/map-model.js";

function moduleDetail(path: string, files: string[], edges: [string, string][] = []): CodeModuleDetail {
  return {
    module: { path, name: path.split("/").pop() ?? path, fileCount: files.length },
    files: files.map((f) => ({
      path: f,
      name: f.split("/").pop()!,
      dir: "",
      importCount: 0,
      exportCount: 1,
    })),
    edges: edges.map(([source, target]) => ({ source, target })),
    moduleDeps: [],
    truncated: false,
  };
}

function input(patch: Partial<CodeContentInput>): CodeContentInput {
  return {
    expanded: new Map(),
    moduleDetails: new Map(),
    fileDetails: new Map<string, CodeFileDetail>(),
    expandedFiles: new Set(),
    openCode: new Set(),
    moves: [],
    ...patch,
  };
}

describe("buildCodeContent", () => {
  it("parents file cards to the diagram node and sizes the container", () => {
    const detail = moduleDetail("packages/core", ["packages/core/src/a.ts", "packages/core/src/b.ts"]);
    const content = buildCodeContent(
      input({
        expanded: new Map([["node_1", "packages/core"]]),
        moduleDetails: new Map([["packages/core", detail]]),
      }),
    );
    expect(content.loading.size).toBe(0);
    const files = content.nodes.filter((n) => n.data.nodeKind === "file");
    expect(files).toHaveLength(2);
    for (const f of files) {
      expect(f.parentId).toBe("node_1");
      expect(f.position.y).toBeGreaterThanOrEqual(ARCH_CODE_HEADER_H);
      expect(f.position.x).toBeGreaterThanOrEqual(MODULE_PAD);
      expect(f.deletable).toBe(false);
    }
    const size = content.sizes.get("node_1")!;
    expect(size.width).toBeGreaterThan(0);
    expect(size.height).toBeGreaterThan(ARCH_CODE_HEADER_H);
  });

  it("marks nodes loading while the module detail is absent", () => {
    const content = buildCodeContent(
      input({ expanded: new Map([["node_1", "packages/core"]]) }),
    );
    expect(content.loading.has("node_1")).toBe(true);
    expect(content.sizes.get("node_1")).toEqual(CODE_LOADING_SIZE);
    expect(content.nodes).toHaveLength(0);
  });

  it("draws module-internal import edges between rendered files", () => {
    const detail = moduleDetail(
      "packages/core",
      ["packages/core/src/a.ts", "packages/core/src/b.ts"],
      [["packages/core/src/a.ts", "packages/core/src/b.ts"]],
    );
    const content = buildCodeContent(
      input({
        expanded: new Map([["node_1", "packages/core"]]),
        moduleDetails: new Map([["packages/core", detail]]),
      }),
    );
    expect(content.edges).toHaveLength(1);
    expect(content.edges[0]!.source).toBe(fileId("packages/core/src/a.ts"));
    expect(content.edges[0]!.target).toBe(fileId("packages/core/src/b.ts"));
  });

  it("bands files by role — entry above service above data", () => {
    const detail: CodeModuleDetail = {
      module: { path: "services/api", name: "api", fileCount: 3 },
      files: [
        { path: "services/api/src/db/client.ts", name: "client.ts", dir: "src/db", importCount: 0, exportCount: 1 },
        { path: "services/api/src/routes.ts", name: "routes.ts", dir: "src", importCount: 0, exportCount: 1 },
        { path: "services/api/src/services/pricing.ts", name: "pricing.ts", dir: "src/services", importCount: 0, exportCount: 1 },
      ],
      edges: [],
      moduleDeps: [],
      truncated: false,
    };
    const content = buildCodeContent(
      input({
        expanded: new Map([["node_1", "services/api"]]),
        moduleDetails: new Map([["services/api", detail]]),
      }),
    );
    const topOf = (path: string) => content.nodes.find((n) => n.id === fileId(path))!.position.y;
    expect(topOf("services/api/src/routes.ts")).toBeLessThan(
      topOf("services/api/src/services/pricing.ts"),
    );
    expect(topOf("services/api/src/services/pricing.ts")).toBeLessThan(
      topOf("services/api/src/db/client.ts"),
    );
  });

  it("caps a large module at the most connected files and adds an overflow chip", () => {
    const paths = Array.from({ length: LIVE_FILE_CAP + 6 }, (_, i) => `packages/core/src/f${i}.ts`);
    // f0 is a hub: everyone imports it, so it must survive the cap.
    const edges = paths.slice(1).map((p): [string, string] => [p, paths[0]!]);
    const detail = moduleDetail("packages/core", paths, edges);
    const content = buildCodeContent(
      input({
        expanded: new Map([["node_1", "packages/core"]]),
        moduleDetails: new Map([["packages/core", detail]]),
      }),
    );
    const files = content.nodes.filter((n) => n.data.nodeKind === "file");
    expect(files).toHaveLength(LIVE_FILE_CAP);
    expect(files.some((n) => n.id === fileId(paths[0]!))).toBe(true);
    const chip = content.nodes.find((n) => n.id === overflowChipId("node_1"));
    expect(chip).toBeDefined();
    expect(chip!.data).toMatchObject({ nodeKind: "overflow", hidden: 6, showingAll: false, nodeId: "node_1" });
  });

  it("shows every file when the node is in showAllFiles, chip flips to 'show fewer'", () => {
    const paths = Array.from({ length: LIVE_FILE_CAP + 6 }, (_, i) => `packages/core/src/f${i}.ts`);
    const detail = moduleDetail("packages/core", paths);
    const content = buildCodeContent(
      input({
        expanded: new Map([["node_1", "packages/core"]]),
        moduleDetails: new Map([["packages/core", detail]]),
        showAllFiles: new Set(["node_1"]),
      }),
    );
    expect(content.nodes.filter((n) => n.data.nodeKind === "file")).toHaveLength(paths.length);
    const chip = content.nodes.find((n) => n.id === overflowChipId("node_1"));
    expect(chip!.data).toMatchObject({ hidden: 0, showingAll: true });
  });

  it("keeps refactor-relevant files visible above the cap", () => {
    const paths = Array.from({ length: LIVE_FILE_CAP + 6 }, (_, i) => `packages/core/src/f${i}.ts`);
    // The last file has no connectivity — it would be capped out…
    const loner = paths[paths.length - 1]!;
    const edges = paths.slice(1, -1).map((p): [string, string] => [p, paths[0]!]);
    const detail = moduleDetail("packages/core", paths, edges);
    const content = buildCodeContent(
      input({
        expanded: new Map([["node_1", "packages/core"]]),
        moduleDetails: new Map([["packages/core", detail]]),
        // …but it's mid-refactor (expanded + being moved), so it stays.
        expandedFiles: new Set([loner]),
      }),
    );
    const files = content.nodes.filter((n) => n.data.nodeKind === "file");
    expect(files.some((n) => n.id === fileId(loner))).toBe(true);
    expect(files.length).toBe(LIVE_FILE_CAP + 1); // cap + the pinned ride-along
  });

  it("declutters edges in dense modules to those touching refactor-relevant files", () => {
    const paths = Array.from({ length: EDGE_FULL_LIMIT + 2 }, (_, i) => `packages/core/src/f${i}.ts`);
    const edges: [string, string][] = [
      [paths[1]!, paths[2]!], // noise
      [paths[3]!, paths[0]!], // touches the expanded file
    ];
    const detail = moduleDetail("packages/core", paths, edges);
    const content = buildCodeContent(
      input({
        expanded: new Map([["node_1", "packages/core"]]),
        moduleDetails: new Map([["packages/core", detail]]),
        expandedFiles: new Set([paths[0]!]),
      }),
    );
    expect(content.edges).toHaveLength(1);
    expect(content.edges[0]!.target).toBe(fileId(paths[0]!));
  });

  it("renders a ghost card for a file planned to move into the module", () => {
    const detail = moduleDetail("packages/core", ["packages/core/src/a.ts"]);
    const content = buildCodeContent(
      input({
        expanded: new Map([["node_1", "packages/core"]]),
        moduleDetails: new Map([["packages/core", detail]]),
        moves: [{ id: "mv1", kind: "moveFile", fromFile: "apps/web/src/x.ts", toModule: "packages/core" }],
      }),
    );
    const ghost = content.nodes.find((n) => n.id === "planfile:mv1");
    expect(ghost).toBeDefined();
    expect(ghost!.parentId).toBe("node_1");
    expect((ghost!.data as { planned?: boolean }).planned).toBe(true);
  });
});

describe("unifiedDropTargetAt", () => {
  const arch = (id: string, x: number, y: number, w: number, h: number, parentId?: string): HitTestNode => ({
    id,
    parentId,
    position: { x, y },
    width: w,
    height: h,
    data: { arch: { id } },
  });
  const fileCard = (path: string, module: string, x: number, y: number, parentId?: string): HitTestNode => ({
    id: fileId(path),
    parentId,
    position: { x, y },
    width: 200,
    height: 46,
    data: { nodeKind: "file", path, module },
  });

  const moduleOf = (id: string) => (id === "svc" ? "services/api" : id === "core" ? "packages/core" : null);

  it("prefers the file card under the point", () => {
    const nodes = [arch("svc", 0, 0, 400, 300), fileCard("services/api/src/x.ts", "services/api", 20, 60, "svc")];
    const hit = unifiedDropTargetAt(nodes, { x: 40, y: 80 }, { file: "a.ts", module: "packages/core" }, moduleOf);
    expect(hit).toEqual({ module: "services/api", file: "services/api/src/x.ts" });
  });

  it("falls back to the diagram node's module and skips the source module", () => {
    const nodes = [arch("svc", 0, 0, 400, 300), arch("core", 500, 0, 400, 300)];
    const hit = unifiedDropTargetAt(nodes, { x: 100, y: 100 }, { file: "a.ts", module: "packages/core" }, moduleOf);
    expect(hit).toEqual({ module: "services/api" });
    const own = unifiedDropTargetAt(nodes, { x: 600, y: 100 }, { file: "a.ts", module: "packages/core" }, moduleOf);
    expect(own).toBeNull();
  });

  it("skips the drag source's own file card", () => {
    const nodes = [fileCard("services/api/src/x.ts", "services/api", 0, 0)];
    const hit = unifiedDropTargetAt(
      nodes,
      { x: 10, y: 10 },
      { file: "services/api/src/x.ts", module: "services/api" },
      moduleOf,
    );
    expect(hit).toBeNull();
  });
});

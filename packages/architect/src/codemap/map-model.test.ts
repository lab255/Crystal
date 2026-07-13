import { describe, expect, it } from "vitest";
import {
  createMoveFileIntent,
  createMoveIntent,
  type CodeFileDetail,
  type CodeMapSummary,
  type CodeModuleDetail,
  type CodeSymbol,
} from "@crystal/core";
import {
  CODE_H,
  FILE_COLLAPSED_H,
  FILE_COLLAPSED_W,
  FILE_EXPANDED_W,
  FILE_HEADER_H,
  FILE_INNER_W,
  MAX_SYMBOLS_SHOWN,
  MODULE_COLLAPSED_H,
  MODULE_COLLAPSED_W,
  MODULE_HEADER_H,
  MODULE_PAD,
  SYM_H,
  SYM_W,
  absolutePositionOf,
  buildMapScene,
  dropTargetAt,
  expandedFileFootprint,
  fileDropTargetAt,
  fileId,
  groupModulesByRepo,
  memberFootprint,
  moduleId,
  moduleOfPath,
  packGrid,
  symbolId,
  FILE_PAD,
  GAP,
  MODULE_INNER_MAX_W,
  type MapLens,
  type MapSceneInput,
  type FileNodeData,
  type ModuleNodeData,
  type SymbolNodeData,
} from "./map-model.js";

const A = "packages/core/src/a.ts";
const B = "packages/ui/src/b.ts";
const C = "packages/ui/src/c.ts";

function summary(): CodeMapSummary {
  return {
    modules: [
      { path: "packages/core", name: "core", fileCount: 2 },
      { path: "packages/ui", name: "ui", fileCount: 2 },
      { path: ".", name: "root", fileCount: 0 },
    ],
    deps: [{ source: "packages/ui", target: "packages/core", weight: 3 }],
    fileTotal: 4,
    generatedAt: "2026-07-06T00:00:00Z",
  };
}

function coreDetail(): CodeModuleDetail {
  return {
    module: { path: "packages/core", name: "core", fileCount: 2 },
    files: [
      { path: A, name: "a.ts", dir: "src", importCount: 1, exportCount: 2 },
      { path: "packages/core/src/d.ts", name: "d.ts", dir: "src", importCount: 0, exportCount: 1 },
    ],
    edges: [],
    moduleDeps: [],
    truncated: false,
  };
}

function uiDetail(): CodeModuleDetail {
  return {
    module: { path: "packages/ui", name: "ui", fileCount: 2 },
    files: [
      { path: B, name: "b.ts", dir: "src", importCount: 0, exportCount: 1 },
      { path: C, name: "c.ts", dir: "src", importCount: 1, exportCount: 0 },
    ],
    edges: [],
    moduleDeps: [{ source: "packages/ui", target: "packages/core", weight: 3 }],
    truncated: false,
  };
}

function fileDetailA(symbols?: CodeSymbol[]): CodeFileDetail {
  return {
    path: A,
    module: "packages/core",
    loc: 40,
    imports: [
      {
        specifier: "../../ui/src/b.js",
        resolved: B,
        targetModule: "packages/ui",
        names: ["b"],
        external: false,
      },
    ],
    exports: [],
    symbols: symbols ?? [
      { name: "foo", kind: "function", line: 1, endLine: 10, exported: true },
      { name: "Bar", kind: "type", line: 12, exported: true },
      { name: "hidden", kind: "const", line: 20, exported: false },
    ],
    importedBy: [C],
  };
}

function fileDetailB(): CodeFileDetail {
  return {
    path: B,
    module: "packages/ui",
    loc: 10,
    imports: [],
    exports: [],
    symbols: [{ name: "b", kind: "function", line: 1, exported: true }],
    importedBy: [A],
  };
}

function input(over: Partial<MapSceneInput> = {}): MapSceneInput {
  return {
    summary: summary(),
    moduleDetails: new Map(),
    fileDetails: new Map(),
    expandedModules: new Set(),
    expandedFiles: new Set(),
    openCode: new Set(),
    moves: [],
    ...over,
  };
}

describe("moduleOfPath", () => {
  it("picks the longest matching module prefix", () => {
    const mods = summary().modules;
    expect(moduleOfPath(A, mods)).toBe("packages/core");
    expect(moduleOfPath("scripts/x.ts", mods)).toBe(".");
    expect(moduleOfPath("packages/ui", mods)).toBe("packages/ui");
  });
});

describe("packGrid", () => {
  it("wraps rows at the max width and reports extents", () => {
    const items = [
      { id: "a", w: 100, h: 20 },
      { id: "b", w: 100, h: 30 },
      { id: "c", w: 100, h: 20 },
    ];
    const { pos, width, height } = packGrid(items, 220, 10);
    expect(pos.get("a")).toEqual({ x: 0, y: 0 });
    expect(pos.get("b")).toEqual({ x: 110, y: 0 });
    // c does not fit next to b (220 < 220 + 100) — wraps under the tallest row item
    expect(pos.get("c")).toEqual({ x: 0, y: 40 });
    expect(width).toBe(210);
    expect(height).toBe(60);
  });

  it("handles empty input", () => {
    expect(packGrid([], 100).height).toBe(0);
  });
});

describe("buildMapScene — collapsed overview", () => {
  it("renders modules as top-level containers with aggregated dep edges", () => {
    const scene = buildMapScene(input());
    // "." has no files and no deps — filtered out
    expect(scene.nodes.map((n) => n.id).sort()).toEqual([
      moduleId("packages/core"),
      moduleId("packages/ui"),
    ]);
    expect(scene.nodes.every((n) => n.parentId === undefined)).toBe(true);
    expect(scene.nodes.every((n) => n.width === MODULE_COLLAPSED_W && n.height === MODULE_COLLAPSED_H)).toBe(true);
    expect(scene.edges).toHaveLength(1);
    expect(scene.edges[0]!.source).toBe(moduleId("packages/ui"));
    expect(scene.edges[0]!.target).toBe(moduleId("packages/core"));
  });

  it("marks an expanded module without detail as loading", () => {
    const scene = buildMapScene(input({ expandedModules: new Set(["packages/core"]) }));
    const core = scene.nodes.find((n) => n.id === moduleId("packages/core"))!;
    expect((core.data as ModuleNodeData).loading).toBe(true);
    expect(scene.nodes.some((n) => n.data.nodeKind === "file")).toBe(false);
  });
});

describe("buildMapScene — expanded module", () => {
  const base = () =>
    input({
      moduleDetails: new Map([["packages/core", coreDetail()]]),
      expandedModules: new Set(["packages/core"]),
    });

  it("nests file cards inside the module, parents before children", () => {
    const scene = buildMapScene(base());
    const ids = scene.nodes.map((n) => n.id);
    const files = scene.nodes.filter((n) => n.data.nodeKind === "file");
    expect(files).toHaveLength(2);
    for (const f of files) {
      expect(f.parentId).toBe(moduleId("packages/core"));
      expect(ids.indexOf(f.parentId!)).toBeLessThan(ids.indexOf(f.id));
      // parent-relative, inside the padded content area
      expect(f.position.x).toBeGreaterThanOrEqual(MODULE_PAD);
      expect(f.position.y).toBeGreaterThanOrEqual(MODULE_HEADER_H);
      expect(f.width).toBe(FILE_COLLAPSED_W);
      expect(f.height).toBe(FILE_COLLAPSED_H);
    }
    const core = scene.nodes.find((n) => n.id === moduleId("packages/core"))!;
    expect(core.width!).toBeGreaterThan(MODULE_COLLAPSED_W);
    expect((core.data as ModuleNodeData).expanded).toBe(true);
  });

  it("expands a file into symbol chips, exported first", () => {
    const scene = buildMapScene({
      ...base(),
      fileDetails: new Map([[A, fileDetailA()]]),
      expandedFiles: new Set([A]),
    });
    const chips = scene.nodes.filter((n) => n.data.nodeKind === "symbol");
    expect(chips.map((c) => (c.data as SymbolNodeData).name)).toEqual(["foo", "Bar", "hidden"]);
    for (const c of chips) expect(c.parentId).toBe(fileId(A));
    const fileNode = scene.nodes.find((n) => n.id === fileId(A))!;
    expect(fileNode.width).toBe(FILE_EXPANDED_W);
    expect(fileNode.height!).toBeGreaterThan(FILE_HEADER_H + SYM_H);
  });

  it("caps symbols and reports overflow", () => {
    const many: CodeSymbol[] = Array.from({ length: MAX_SYMBOLS_SHOWN + 6 }, (_, i) => ({
      name: `s${i}`,
      kind: "function",
      line: i + 1,
      exported: true,
    }));
    const scene = buildMapScene({
      ...base(),
      fileDetails: new Map([[A, fileDetailA(many)]]),
      expandedFiles: new Set([A]),
    });
    const chips = scene.nodes.filter((n) => n.data.nodeKind === "symbol");
    expect(chips).toHaveLength(MAX_SYMBOLS_SHOWN);
    const fileNode = scene.nodes.find((n) => n.id === fileId(A))!;
    expect((fileNode.data as FileNodeData).overflow).toBe(6);
  });

  it("grows a chip (and its file) when its code is open", () => {
    const closed = buildMapScene({
      ...base(),
      fileDetails: new Map([[A, fileDetailA()]]),
      expandedFiles: new Set([A]),
    });
    const open = buildMapScene({
      ...base(),
      fileDetails: new Map([[A, fileDetailA()]]),
      expandedFiles: new Set([A]),
      openCode: new Set([`${A}#foo`]),
    });
    const chip = open.nodes.find((n) => n.id === symbolId(A, "foo"))!;
    expect(chip.width).toBe(FILE_INNER_W);
    expect(chip.height).toBe(SYM_H + CODE_H);
    const fileClosed = closed.nodes.find((n) => n.id === fileId(A))!;
    const fileOpen = open.nodes.find((n) => n.id === fileId(A))!;
    expect(fileOpen.height!).toBeGreaterThan(fileClosed.height!);
  });
});

describe("buildMapScene — draft move overlay", () => {
  it("marks source chip + renders a planned ghost in the expanded target file", () => {
    const mv = createMoveIntent("foo", A, "packages/ui", B);
    const scene = buildMapScene(
      input({
        moduleDetails: new Map([
          ["packages/core", coreDetail()],
          ["packages/ui", uiDetail()],
        ]),
        fileDetails: new Map([
          [A, fileDetailA()],
          [B, fileDetailB()],
        ]),
        expandedModules: new Set(["packages/core", "packages/ui"]),
        expandedFiles: new Set([A, B]),
        moves: [mv],
      }),
    );
    const source = scene.nodes.find((n) => n.id === symbolId(A, "foo"))!;
    expect((source.data as SymbolNodeData).moving).toBe(true);
    expect((source.data as SymbolNodeData).moveLabel).toBe("→ b.ts");
    const ghost = scene.nodes.find((n) => n.id === `plan:${mv.id}`)!;
    expect(ghost.parentId).toBe(fileId(B));
    expect((ghost.data as SymbolNodeData).planned).toBe(true);
    expect((ghost.data as SymbolNodeData).kind).toBe("function");
  });

  it("badges collapsed targets instead", () => {
    const mv = createMoveIntent("foo", A, "packages/ui", B);
    const scene = buildMapScene(
      input({
        moduleDetails: new Map([["packages/ui", uiDetail()]]),
        expandedModules: new Set(["packages/ui"]),
        moves: [mv],
      }),
    );
    const fileB = scene.nodes.find((n) => n.id === fileId(B))!;
    expect((fileB.data as FileNodeData).intentMark).toBe("target");
    const coreModule = scene.nodes.find((n) => n.id === moduleId("packages/core"))!;
    expect((coreModule.data as ModuleNodeData).intentMark).toBe("source");
    const uiModule = scene.nodes.find((n) => n.id === moduleId("packages/ui"))!;
    expect((uiModule.data as ModuleNodeData).intentMark).toBe("target");
  });
});

describe("buildMapScene — whole-file move overlay", () => {
  it("marks the source card and renders a ghost card in the expanded target module", () => {
    const mv = createMoveFileIntent(A, "packages/ui");
    const scene = buildMapScene(
      input({
        moduleDetails: new Map([
          ["packages/core", coreDetail()],
          ["packages/ui", uiDetail()],
        ]),
        expandedModules: new Set(["packages/core", "packages/ui"]),
        moves: [mv],
      }),
    );
    const source = scene.nodes.find((n) => n.id === fileId(A))!;
    expect((source.data as FileNodeData).moving).toBe(true);
    expect((source.data as FileNodeData).moveLabel).toBe("→ packages/ui");
    expect(source.draggable).toBe(true);

    const ghost = scene.nodes.find((n) => n.id === `planfile:${mv.id}`)!;
    expect(ghost.parentId).toBe(moduleId("packages/ui"));
    expect((ghost.data as FileNodeData).planned).toBe(true);
    expect((ghost.data as FileNodeData).name).toBe("a.ts");
    expect(ghost.draggable).toBe(false);

    expect((scene.nodes.find((n) => n.id === moduleId("packages/core"))!.data as ModuleNodeData).intentMark).toBe("source");
    expect((scene.nodes.find((n) => n.id === moduleId("packages/ui"))!.data as ModuleNodeData).intentMark).toBe("target");
  });

  it("badges the collapsed target module without a ghost", () => {
    const mv = createMoveFileIntent(A, "packages/ui");
    const scene = buildMapScene(input({ moves: [mv] }));
    expect(scene.nodes.some((n) => n.id === `planfile:${mv.id}`)).toBe(false);
    expect((scene.nodes.find((n) => n.id === moduleId("packages/ui"))!.data as ModuleNodeData).intentMark).toBe("target");
  });
});

describe("buildMapScene — selection edges", () => {
  it("aggregates the selected file's neighborhood to visible nodes", () => {
    const scene = buildMapScene(
      input({
        moduleDetails: new Map([["packages/core", coreDetail()]]),
        fileDetails: new Map([[A, fileDetailA()]]),
        expandedModules: new Set(["packages/core"]),
        expandedFiles: new Set([A]),
        selectedFile: A,
      }),
    );
    const sel = scene.edges.filter((e) => e.id.startsWith("sel:"));
    // import → ui module (collapsed), importedBy ← ui module
    expect(sel).toHaveLength(2);
    const out = sel.find((e) => e.id.startsWith("sel:out"))!;
    expect(out.source).toBe(fileId(A));
    expect(out.target).toBe(moduleId("packages/ui"));
    const inc = sel.find((e) => e.id.startsWith("sel:in"))!;
    expect(inc.source).toBe(moduleId("packages/ui"));
    expect(inc.target).toBe(fileId(A));
  });

  it("targets the file card when the neighbor module is expanded", () => {
    const scene = buildMapScene(
      input({
        moduleDetails: new Map([
          ["packages/core", coreDetail()],
          ["packages/ui", uiDetail()],
        ]),
        fileDetails: new Map([[A, fileDetailA()]]),
        expandedModules: new Set(["packages/core", "packages/ui"]),
        selectedFile: A,
      }),
    );
    const out = scene.edges.find((e) => e.id.startsWith("sel:out"))!;
    expect(out.target).toBe(fileId(B));
    const inc = scene.edges.find((e) => e.id.startsWith("sel:in"))!;
    expect(inc.source).toBe(fileId(C));
  });

  it("draws nothing when the selected file is not on the canvas", () => {
    const scene = buildMapScene(
      input({
        fileDetails: new Map([[A, fileDetailA()]]),
        selectedFile: A,
      }),
    );
    expect(scene.edges.some((e) => e.id.startsWith("sel:"))).toBe(false);
  });
});

describe("buildMapScene — facet lens", () => {
  const lens: MapLens = {
    files: new Map([[A, new Set(["foo"])]]),
    modules: new Set(["packages/core"]),
  };

  it("hides modules, files and members outside the lens", () => {
    const scene = buildMapScene(
      input({
        moduleDetails: new Map([
          ["packages/core", coreDetail()],
          ["packages/ui", uiDetail()],
        ]),
        fileDetails: new Map([[A, fileDetailA()]]),
        expandedModules: new Set(["packages/core", "packages/ui"]),
        expandedFiles: new Set([A]),
        lens,
      }),
    );
    expect(scene.nodes.some((n) => n.id === moduleId("packages/ui"))).toBe(false);
    const files = scene.nodes.filter((n) => n.data.nodeKind === "file");
    expect(files.map((f) => f.id)).toEqual([fileId(A)]);
    const chips = scene.nodes.filter((n) => n.data.nodeKind === "symbol");
    expect(chips.map((c) => (c.data as SymbolNodeData).name)).toEqual(["foo"]);
    // the ui→core dep edge lost an endpoint — dropped
    expect(scene.edges).toHaveLength(0);
  });

  it('renders every member of an "all" file', () => {
    const scene = buildMapScene(
      input({
        moduleDetails: new Map([["packages/core", coreDetail()]]),
        fileDetails: new Map([[A, fileDetailA()]]),
        expandedModules: new Set(["packages/core"]),
        expandedFiles: new Set([A]),
        lens: { files: new Map([[A, "all"]]), modules: new Set(["packages/core"]) },
      }),
    );
    const chips = scene.nodes.filter((n) => n.data.nodeKind === "symbol");
    expect(chips.map((c) => (c.data as SymbolNodeData).name)).toEqual(["foo", "Bar", "hidden"]);
  });

  it("dir prefixes admit whole files — the structural (system) lens", () => {
    const scene = buildMapScene(
      input({
        moduleDetails: new Map([["packages/core", coreDetail()]]),
        fileDetails: new Map([[A, fileDetailA()]]),
        expandedModules: new Set(["packages/core"]),
        expandedFiles: new Set([A]),
        lens: { files: new Map(), dirs: ["packages/core/src"], modules: new Set(["packages/core"]) },
      }),
    );
    // Both core files fall under the dir; every member of A renders ("all").
    const files = scene.nodes.filter((n) => n.data.nodeKind === "file");
    expect(files.map((f) => f.id).sort()).toEqual(
      [fileId(A), fileId("packages/core/src/d.ts")].sort(),
    );
    const chips = scene.nodes.filter((n) => n.data.nodeKind === "symbol");
    expect(chips.map((c) => (c.data as SymbolNodeData).name)).toEqual(["foo", "Bar", "hidden"]);
    // A sibling dir does not match by mere string prefix ("src2" ≠ "src/…").
    const miss = buildMapScene(
      input({
        moduleDetails: new Map([["packages/core", coreDetail()]]),
        expandedModules: new Set(["packages/core"]),
        lens: { files: new Map(), dirs: ["packages/core/sr"], modules: new Set(["packages/core"]) },
      }),
    );
    expect(miss.nodes.filter((n) => n.data.nodeKind === "file")).toHaveLength(0);
  });

  it("context modules render collapsed + dimmed, wired only into the lens", () => {
    const scene = buildMapScene(
      input({
        moduleDetails: new Map([
          ["packages/core", coreDetail()],
          ["packages/ui", uiDetail()],
        ]),
        fileDetails: new Map([[A, fileDetailA()]]),
        expandedModules: new Set(["packages/core", "packages/ui"]),
        expandedFiles: new Set([A]),
        lens: {
          files: new Map([[A, "all"]]),
          modules: new Set(["packages/core"]),
          context: new Set(["packages/ui"]),
        },
      }),
    );
    const ui = scene.nodes.find((n) => n.id === moduleId("packages/ui"))!;
    const uiData = ui.data as ModuleNodeData;
    expect(uiData.dimmed).toBe(true);
    // Collapsed despite being in expandedModules — its files are out of lens.
    expect(uiData.expanded).toBe(false);
    expect(scene.nodes.some((n) => n.id === fileId(B))).toBe(false);
    // The ui→core edge survives because it touches a lens member.
    expect(scene.edges.map((e) => e.id)).toEqual(["dep:packages/ui->packages/core"]);
  });
});

describe("buildMapScene — reserved layout", () => {
  it("spaces modules by their member footprint while rendering collapsed cards", () => {
    const plain = buildMapScene(input());
    const reserved = buildMapScene(
      input({
        layoutSizes: new Map([
          ["packages/core", { w: 900, h: 700 }],
          ["packages/ui", { w: 900, h: 700 }],
        ]),
      }),
    );
    const gapOf = (scene: ReturnType<typeof buildMapScene>) => {
      const core = scene.nodes.find((n) => n.id === moduleId("packages/core"))!;
      const ui = scene.nodes.find((n) => n.id === moduleId("packages/ui"))!;
      return Math.abs(
        core.position.y + core.height! / 2 - (ui.position.y + ui.height! / 2),
      );
    };
    expect(gapOf(reserved)).toBeGreaterThan(gapOf(plain));
    // cards themselves stay collapsed-size, centered in the reserved slot
    const core = reserved.nodes.find((n) => n.id === moduleId("packages/core"))!;
    expect(core.width).toBe(MODULE_COLLAPSED_W);
    expect(core.height).toBe(MODULE_COLLAPSED_H);
  });
});

describe("LoD footprints", () => {
  it("expandedFileFootprint mirrors the two-column chip grid", () => {
    expect(expandedFileFootprint(0)).toEqual({
      w: FILE_EXPANDED_W,
      h: FILE_HEADER_H + FILE_PAD,
    });
    // 3 symbols → 2 rows of chips
    expect(expandedFileFootprint(3).h).toBe(FILE_HEADER_H + SYM_H * 2 + GAP + FILE_PAD);
    // over the display cap → the "+N more" strip is included
    expect(expandedFileFootprint(MAX_SYMBOLS_SHOWN + 1).h).toBe(
      expandedFileFootprint(MAX_SYMBOLS_SHOWN).h + 18,
    );
  });

  it("memberFootprint matches the fully expanded module geometry", () => {
    const detail = coreDetail();
    const fp = memberFootprint(detail, () => 3);
    const fileH = expandedFileFootprint(3).h;
    // two expanded files fit one row inside MODULE_INNER_MAX_W
    expect(FILE_EXPANDED_W * 2 + GAP).toBeLessThanOrEqual(MODULE_INNER_MAX_W);
    expect(fp).toEqual({
      w: FILE_EXPANDED_W * 2 + GAP + MODULE_PAD * 2,
      h: MODULE_HEADER_H + fileH + MODULE_PAD,
    });
  });
});

describe("groupModulesByRepo", () => {
  const repoSummary = (): CodeMapSummary => ({
    modules: [
      { path: ".", name: "host", fileCount: 3 },
      { path: "packages/core", name: "core", fileCount: 2 },
      { path: "vendor/lib", name: "lib", fileCount: 2, versioned: true },
      { path: "vendor/lib/sub", name: "sub", fileCount: 1 },
    ],
    deps: [
      { source: "packages/core", target: "vendor/lib", weight: 2 },
      { source: ".", target: "packages/core", weight: 1 },
      { source: "packages/core", target: "vendor/lib/sub", weight: 4 },
    ],
    fileTotal: 8,
    generatedAt: "2026-07-06T00:00:00Z",
  });

  it("groups by nearest versioned root and aggregates deps", () => {
    const { repos, repoOf, deps } = groupModulesByRepo(repoSummary());
    expect(repoOf.get("packages/core")).toBe(".");
    expect(repoOf.get("vendor/lib")).toBe("vendor/lib");
    expect(repoOf.get("vendor/lib/sub")).toBe("vendor/lib");
    expect(repos.map((r) => r.path).sort()).toEqual([".", "vendor/lib"]);
    const host = repos.find((r) => r.path === ".")!;
    expect(host.name).toBe("host");
    expect(host.fileCount).toBe(5);
    expect(host.modules.map((m) => m.path).sort()).toEqual([".", "packages/core"]);
    // core→lib (2) + core→lib/sub (4) fold into one repo edge; intra-repo dropped
    expect(deps).toEqual([{ source: ".", target: "vendor/lib", weight: 6 }]);
  });
});

describe("buildMapScene — manual positions", () => {
  it("pins dragged modules and lets dagre place the rest", () => {
    const pinned = { x: 1234, y: 567 };
    const scene = buildMapScene(
      input({ positions: new Map([["packages/core", pinned]]) }),
    );
    const core = scene.nodes.find((n) => n.id === moduleId("packages/core"))!;
    expect(core.position).toEqual(pinned);
    const ui = scene.nodes.find((n) => n.id === moduleId("packages/ui"))!;
    expect(ui.position).not.toEqual(pinned);
  });
});

describe("dropTargetAt", () => {
  function expandedScene() {
    return buildMapScene(
      input({
        moduleDetails: new Map([
          ["packages/core", coreDetail()],
          ["packages/ui", uiDetail()],
        ]),
        fileDetails: new Map([[A, fileDetailA()]]),
        expandedModules: new Set(["packages/core", "packages/ui"]),
        expandedFiles: new Set([A]),
      }),
    );
  }

  const centerOf = (nodes: ReturnType<typeof expandedScene>["nodes"], id: string) => {
    const n = nodes.find((x) => x.id === id)!;
    const abs = absolutePositionOf(nodes, id)!;
    return { x: abs.x + n.width! / 2, y: abs.y + n.height! / 2 };
  };

  it("prefers the file card under the point", () => {
    const { nodes } = expandedScene();
    const target = dropTargetAt(nodes, centerOf(nodes, fileId(B)), {
      file: A,
      module: "packages/core",
    });
    expect(target).toEqual({ module: "packages/ui", file: B });
  });

  it("falls back to the module container and ignores the chip's own scope", () => {
    const { nodes } = expandedScene();
    // module header strip of ui: just below the top edge, away from file cards
    const abs = absolutePositionOf(nodes, moduleId("packages/ui"))!;
    const headerPoint = { x: abs.x + 10, y: abs.y + 10 };
    expect(
      dropTargetAt(nodes, headerPoint, { file: A, module: "packages/core" }),
    ).toEqual({ module: "packages/ui" });

    // own file and own module are not targets
    expect(
      dropTargetAt(nodes, centerOf(nodes, fileId(A)), { file: A, module: "packages/core" }),
    ).toBeNull();
    expect(dropTargetAt(nodes, { x: -10_000, y: -10_000 }, { file: A, module: "packages/core" })).toBeNull();
  });

  it("resolves file drags to modules only, never within the own module", () => {
    const { nodes } = expandedScene();
    // dropping file A onto file B of another module → that module
    expect(fileDropTargetAt(nodes, centerOf(nodes, fileId(B)), A, "packages/core")).toEqual({
      module: "packages/ui",
    });
    // dropping onto a sibling file in the same module → null
    expect(
      fileDropTargetAt(nodes, centerOf(nodes, fileId("packages/core/src/d.ts")), A, "packages/core"),
    ).toBeNull();
    expect(fileDropTargetAt(nodes, { x: -10_000, y: -10_000 }, A, "packages/core")).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import type { ArchitectureGraph } from "@crystal/core";
import type { NavPatch } from "./nav-store.js";
import { symbolMenuEntries, type SymbolMenuContext } from "./symbol-menu.js";

const ctx = (over: Partial<SymbolMenuContext> = {}): SymbolMenuContext & { patches: NavPatch[] } => {
  const patches: NavPatch[] = [];
  return { nav: (p) => void patches.push(p), ws: "ws1", pinnedSel: null, patches, ...over };
};

const labels = (entries: ReturnType<typeof symbolMenuEntries>): string[] =>
  entries.map((e) => (e.type === "separator" ? "—" : e.label));

describe("symbolMenuEntries", () => {
  it("builds the standard block for a symbol", () => {
    const c = ctx();
    const entries = symbolMenuEntries({ file: "src/auth/login.ts", symbol: "login", line: 12 }, c);
    expect(labels(entries)).toEqual([
      "Pin highlight",
      "Open in editor",
      "Show in code map",
      "Show coverage",
      "—",
      "Copy reference",
    ]);
    const editor = entries[1]!;
    expect(editor.type === "item" && editor.hint).toBe("login.ts:12");
  });

  it("routes test files to the test runner instead of coverage", () => {
    const c = ctx();
    const entries = symbolMenuEntries({ file: "src/auth/login.test.ts" }, c);
    expect(labels(entries)).toContain("Show in test runner");
    expect(labels(entries)).not.toContain("Show coverage");
    const item = entries.find((e) => e.type === "item" && e.label === "Show in test runner");
    if (item?.type === "item") item.onSelect();
    expect(c.patches).toEqual([
      { mode: "quality", quality: { view: "tests", file: "src/auth/login.test.ts" } },
    ]);
  });

  it("drills the code map to the file and pins the selection", () => {
    const c = ctx();
    const entries = symbolMenuEntries({ file: "src/a.ts", symbol: "fn" }, c);
    const item = entries.find((e) => e.type === "item" && e.label === "Show in code map");
    if (item?.type === "item") item.onSelect();
    expect(c.patches).toEqual([
      {
        mode: "architect",
        architect: {
          view: "codemap",
          codemap: { kind: "file", ws: "ws1", path: "src/a.ts" },
          sel: "sym:src/a.ts#fn",
        },
      },
    ]);
  });

  it("falls back to a module drill and Copy path without a file", () => {
    const entries = symbolMenuEntries({ module: "packages/core" }, ctx());
    expect(labels(entries)).toEqual(["Pin highlight", "Show in code map", "—", "Copy path"]);
  });

  it("omits the code map entry without an active workspace", () => {
    const entries = symbolMenuEntries({ file: "src/a.ts" }, ctx({ ws: null }));
    expect(labels(entries)).not.toContain("Show in code map");
  });

  it("toggles to Unpin when the target is already pinned", () => {
    const c = ctx({ pinnedSel: "sym:src/a.ts#fn" });
    const entries = symbolMenuEntries({ file: "src/a.ts", symbol: "fn" }, c);
    const pin = entries[0]!;
    expect(pin.type === "item" && pin.label).toBe("Unpin highlight");
    if (pin.type === "item") pin.onSelect();
    expect(c.patches).toEqual([{ architect: { sel: null } }]);
  });

  it("suppresses omitted groups and never leads with a separator", () => {
    const entries = symbolMenuEntries(
      { file: "src/a.ts", symbol: "fn" },
      ctx(),
      { omit: ["pin", "editor", "codemap", "quality"] },
    );
    expect(labels(entries)).toEqual(["Copy reference"]);
  });

  it("adds view-local actions only when their callbacks are provided", () => {
    const seen: string[] = [];
    const entries = symbolMenuEntries(
      { file: "src/a.ts", symbol: "fn", module: "src" },
      ctx(),
      {
        revealOnDiagram: () => void seen.push("reveal"),
        zoomIntoCode: () => void seen.push("zoom"),
        startJourney: () => void seen.push("journey"),
        openTerminal: () => void seen.push("terminal"),
      },
    );
    for (const label of [
      "Show on architecture diagram",
      "Zoom into code",
      "Start journey here",
      "Open terminal at module",
    ]) {
      const item = entries.find((e) => e.type === "item" && e.label === label);
      expect(item, label).toBeDefined();
      if (item?.type === "item") item.onSelect();
    }
    expect(seen).toEqual(["reveal", "zoom", "journey", "terminal"]);
  });

  it("skips the journey entry without a symbol", () => {
    const entries = symbolMenuEntries({ file: "src/a.ts" }, ctx(), { startJourney: () => {} });
    expect(labels(entries)).not.toContain("Start journey here");
  });

  it("builds the hierarchy submenu from the graph ancestor chain", () => {
    const graph = {
      nodes: [
        { id: "root", label: "Platform", kind: "system" },
        { id: "svc", label: "Auth service", kind: "service" },
      ],
      edges: [],
    } as unknown as ArchitectureGraph;
    const entries = symbolMenuEntries(
      { node: "leaf", nodePath: ["root", "svc"] },
      ctx(),
      { graph },
    );
    const sub = entries.find((e) => e.type === "submenu");
    expect(sub?.type === "submenu" && sub.entries.map((e) => e.type === "item" && e.label)).toEqual([
      "Platform",
      "Auth service",
    ]);
  });
});

import { describe, expect, it } from "vitest";
import { parseCrystalFile, serializeCrystalFile } from "./serialization.js";
import { autoGroupSystems, createSystemsLayout, type SystemsLayout } from "./systems-layout.js";
import type { SystemModule } from "./system-overview.js";

const sys = (id: string, layer: SystemModule["layer"]): SystemModule =>
  ({ id, layer }) as SystemModule;

describe("autoGroupSystems", () => {
  it("groups systems by layer in ladder order", () => {
    const groups = autoGroupSystems({
      systems: [
        sys("sys:api", "backend"),
        sys("sys:web", "frontend"),
        sys("sys:store", "database"),
        sys("sys:worker", "backend"),
      ],
    });
    expect(groups.map((g) => g.id)).toEqual(["grp:frontend", "grp:backend", "grp:database"]);
    expect(groups.find((g) => g.id === "grp:backend")!.members).toEqual([
      "sys:api",
      "sys:worker",
    ]);
    expect(groups[0]!.name).toBe("Frontend");
  });

  it("returns no groups when every system shares one layer", () => {
    const groups = autoGroupSystems({
      systems: [sys("sys:a", "backend"), sys("sys:b", "backend")],
    });
    expect(groups).toEqual([]);
  });
});

describe("syslayout envelope", () => {
  it("round-trips through the crystal file envelope", () => {
    const layout: SystemsLayout = {
      positions: { "sys:api": { x: 12, y: -4 }, "grp:backend": { x: 0, y: 100 } },
      groups: [{ id: "grp:backend", name: "Backend", members: ["sys:api"] }],
    };
    const parsed = parseCrystalFile("syslayout", serializeCrystalFile("syslayout", layout));
    expect(parsed).toEqual(layout);
  });

  it("rejects malformed layouts", () => {
    const bad = serializeCrystalFile(
      "syslayout",
      { positions: { a: { x: "no" } }, groups: [] } as unknown as SystemsLayout,
    );
    expect(() => parseCrystalFile("syslayout", bad)).toThrow(/Invalid syslayout/);
  });

  it("starts empty", () => {
    expect(createSystemsLayout()).toEqual({ positions: {}, groups: [] });
  });
});

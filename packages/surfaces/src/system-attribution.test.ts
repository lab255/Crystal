import { describe, expect, it } from "vitest";
import type { SystemModule } from "@crystal/core";
import { makeSystemAttributor } from "./system-attribution.js";

function system(id: string, ...paths: string[]): SystemModule {
  return {
    id,
    name: id,
    concept: null,
    role: "domain",
    layer: "backend",
    parts: paths.map((path) => ({ path, pkg: ".", fileCount: 1 })),
    fileCount: paths.length,
    intents: [],
    exports: [],
    exportedTotal: 0,
    externals: [],
    libraries: [],
    endpoints: [],
    components: [],
    componentCount: 0,
  };
}

describe("makeSystemAttributor", () => {
  it("attributes an exact part path", () => {
    const owner = system("sys:api", "packages/api");

    expect(makeSystemAttributor([owner])("packages/api")).toBe(owner);
  });

  it("attributes a descendant of a part path", () => {
    const owner = system("sys:api", "packages/api");

    expect(makeSystemAttributor([owner])("packages/api/src/routes.ts")).toBe(owner);
  });

  it("uses the longest matching prefix", () => {
    const broad = system("sys:packages", "packages");
    const narrow = system("sys:api", "packages/api");

    expect(makeSystemAttributor([broad, narrow])("packages/api/src/routes.ts")).toBe(narrow);
  });

  it("identical part path: first system in input order wins", () => {
    const later = system("sys:later", "packages/api");
    const earlier = system("sys:earlier", "packages/api");

    expect(makeSystemAttributor([later, earlier])("packages/api/src/routes.ts")).toBe(later);
  });

  it("returns null when no part path matches", () => {
    const owner = system("sys:api", "packages/api");

    expect(makeSystemAttributor([owner])("packages/web/src/app.tsx")).toBeNull();
  });

  it("returns the identical system object for repeated files", () => {
    const owner = system("sys:api", "packages/api");
    const attribute = makeSystemAttributor([owner]);
    const first = attribute("packages/api/src/routes.ts");

    expect(attribute("packages/api/src/routes.ts")).toBe(first);
  });
});

import { describe, expect, it } from "vitest";
import { loadTsPathsConfig, sortTsPathsConfigs, tsPathsCandidates } from "./ts-paths.js";

function reader(files: Record<string, string>) {
  return (rel: string): string | null => files[rel] ?? null;
}

describe("loadTsPathsConfig", () => {
  it("compiles a wildcard alias anchored to baseUrl", async () => {
    const config = await loadTsPathsConfig(
      reader({
        "packages/app/tsconfig.json": JSON.stringify({
          compilerOptions: { baseUrl: "./src", paths: { "@/*": ["./*"] } },
        }),
      }),
      "packages/app/tsconfig.json",
    );
    expect(config).toEqual({
      dir: "packages/app",
      patterns: [
        { prefix: "@/", suffix: "", exact: false, targets: ["packages/app/src/*"] },
      ],
    });
  });

  it("anchors targets to the config dir when baseUrl is absent", async () => {
    const config = await loadTsPathsConfig(
      reader({
        "tsconfig.json": JSON.stringify({
          compilerOptions: { paths: { "~lib/*": ["lib/src/*", "lib/fallback/*"] } },
        }),
      }),
      "tsconfig.json",
    );
    expect(config?.dir).toBe(".");
    expect(config?.patterns[0]?.targets).toEqual(["lib/src/*", "lib/fallback/*"]);
  });

  it("inherits paths through relative extends chains, child overriding", async () => {
    const files = {
      "tsconfig.base.json": JSON.stringify({
        compilerOptions: { baseUrl: ".", paths: { "#shared/*": ["shared/*"] } },
      }),
      "packages/app/tsconfig.json": JSON.stringify({
        extends: "../../tsconfig.base.json",
        compilerOptions: {},
      }),
      "packages/web/tsconfig.json": JSON.stringify({
        extends: "../../tsconfig.base.json",
        compilerOptions: { baseUrl: "./src", paths: { "@/*": ["./*"] } },
      }),
    };
    const inherited = await loadTsPathsConfig(reader(files), "packages/app/tsconfig.json");
    // Inherited paths keep the declaring config's anchor (workspace root).
    expect(inherited?.patterns[0]).toMatchObject({ prefix: "#shared/", targets: ["shared/*"] });
    // The child config governs files under its own dir.
    expect(inherited?.dir).toBe("packages/app");

    const overridden = await loadTsPathsConfig(reader(files), "packages/web/tsconfig.json");
    expect(overridden?.patterns).toHaveLength(1);
    expect(overridden?.patterns[0]).toMatchObject({ prefix: "@/", targets: ["packages/web/src/*"] });
  });

  it("tolerates JSONC comments and trailing commas", async () => {
    const config = await loadTsPathsConfig(
      reader({
        "tsconfig.json": `{
  // aliases
  "compilerOptions": {
    "paths": { "@app/*": ["src/*"], },
  },
}`,
      }),
      "tsconfig.json",
    );
    expect(config?.patterns[0]?.prefix).toBe("@app/");
  });

  it("returns null without paths, on unreadable configs, and on extends cycles", async () => {
    expect(
      await loadTsPathsConfig(
        reader({ "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true } }) }),
        "tsconfig.json",
      ),
    ).toBeNull();
    expect(await loadTsPathsConfig(reader({}), "tsconfig.json")).toBeNull();
    const cyclic = {
      "a/tsconfig.json": JSON.stringify({ extends: "../b/tsconfig.json" }),
      "b/tsconfig.json": JSON.stringify({ extends: "../a/tsconfig.json" }),
    };
    expect(await loadTsPathsConfig(reader(cyclic), "a/tsconfig.json")).toBeNull();
  });

  it("drops targets escaping the workspace and multi-star patterns", async () => {
    const config = await loadTsPathsConfig(
      reader({
        "tsconfig.json": JSON.stringify({
          compilerOptions: {
            paths: {
              "@out/*": ["../outside/*"],
              "@*weird*": ["src/*"],
              "@ok/*": ["src/ok/*"],
            },
          },
        }),
      }),
      "tsconfig.json",
    );
    expect(config?.patterns).toHaveLength(1);
    expect(config?.patterns[0]?.prefix).toBe("@ok/");
  });
});

describe("tsPathsCandidates", () => {
  const configs = sortTsPathsConfigs([
    {
      dir: ".",
      patterns: [{ prefix: "#root/", suffix: "", exact: false, targets: ["rootlib/*"] }],
    },
    {
      dir: "packages/app",
      patterns: [
        { prefix: "@", suffix: "", exact: true, targets: ["packages/app/src/index.ts"] },
        { prefix: "@/", suffix: "", exact: false, targets: ["packages/app/src/*"] },
      ],
    },
  ]);

  it("maps a wildcard alias for files governed by the config", () => {
    expect(tsPathsCandidates("packages/app/src/router/routes.tsx", "@/pages/apps", configs))
      .toEqual(["packages/app/src/pages/apps"]);
  });

  it("matches exact (starless) patterns verbatim", () => {
    expect(tsPathsCandidates("packages/app/src/a.ts", "@", configs)).toEqual([
      "packages/app/src/index.ts",
    ]);
  });

  it("ignores configs that do not govern the importing file", () => {
    expect(tsPathsCandidates("packages/other/src/a.ts", "@/pages/apps", configs)).toEqual([]);
    expect(tsPathsCandidates("packages/other/src/a.ts", "#root/util", configs)).toEqual([
      "rootlib/util",
    ]);
  });

  it("prefers exact over wildcard patterns (TS selection order)", () => {
    // "@" matches both the exact pattern and "@/*"? No — "@" lacks the "/",
    // but a specifier matching two wildcard patterns picks the longer prefix.
    const overlapping = [
      {
        dir: ".",
        patterns: [
          { prefix: "@/deep/", suffix: "", exact: false, targets: ["deep/*"] },
          { prefix: "@/", suffix: "", exact: false, targets: ["shallow/*"] },
        ],
      },
    ];
    expect(tsPathsCandidates("a.ts", "@/deep/x", sortTsPathsConfigs(overlapping))).toEqual([
      "deep/x",
    ]);
  });
});

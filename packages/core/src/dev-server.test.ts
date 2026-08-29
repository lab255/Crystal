import { describe, expect, it } from "vitest";
import { devServerCandidatesForPackage, matchDevUrl } from "./dev-server.js";

describe("devServerCandidatesForPackage", () => {
  it("detects vite under any script key, with its default port", () => {
    const out = devServerCandidatesForPackage("apps/web", "@crystal/web", { web: "vite" });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      id: "apps/web::web",
      kind: "app",
      urlGuess: "http://localhost:5173",
    });
  });

  it("does not mistake vitest for vite", () => {
    expect(
      devServerCandidatesForPackage(".", null, { test: "vitest", dev: "vitest --watch" }),
    ).toEqual([]);
  });

  it("keeps orchestration dev scripts as portless task candidates", () => {
    const out = devServerCandidatesForPackage(".", "monorepo", {
      dev: "pnpm --parallel --filter @crystal/server --filter @crystal/web dev",
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: "task", urlGuess: null });
  });

  it("respects explicit port flags over tool defaults", () => {
    const out = devServerCandidatesForPackage(".", null, {
      storybook: "storybook dev -p 7007",
    });
    expect(out[0]).toMatchObject({ kind: "storybook", urlGuess: "http://localhost:7007" });
  });

  it("skips builds, linters, test runners and lifecycle hooks", () => {
    expect(
      devServerCandidatesForPackage(".", null, {
        build: "vite build",
        predev: "node scripts/gen.js",
        lint: "eslint .",
        "dev:e2e": "playwright test --ui",
      }),
    ).toEqual([]);
  });

  it("classifies watch-mode node servers as api", () => {
    const out = devServerCandidatesForPackage("apps/server", "@crystal/server", {
      dev: "tsx watch src/main.ts",
    });
    expect(out[0]).toMatchObject({ kind: "api", urlGuess: null });
  });

  it("orders apps before storybooks before tasks", () => {
    const out = devServerCandidatesForPackage(".", null, {
      watch: "pnpm run -r watch",
      storybook: "storybook dev",
      dev: "next dev",
    });
    expect(out.map((c) => c.kind)).toEqual(["app", "storybook", "task"]);
  });
});

describe("matchDevUrl", () => {
  const ESC = String.fromCharCode(27);

  it("finds the local URL in vite banner output (ANSI included)", () => {
    const text = `  ${ESC}[32m>${ESC}[39m  Local:   ${ESC}[36mhttp://localhost:5174/${ESC}[39m\n`;
    expect(matchDevUrl(text)).toBe("http://localhost:5174");
  });

  it("normalizes 0.0.0.0 binds to localhost", () => {
    expect(matchDevUrl("Listening on http://0.0.0.0:8080")).toBe("http://localhost:8080");
  });

  it("keeps only the origin — a logged deep link is not the base URL", () => {
    expect(matchDevUrl("GET /invite/x 200 http://localhost:3000/invite/Xiq6j-pblAP/ 43ms")).toBe(
      "http://localhost:3000",
    );
    expect(matchDevUrl("- Local: http://localhost:3000/")).toBe("http://localhost:3000");
  });

  it("ignores non-local URLs and plain text", () => {
    expect(matchDevUrl("see https://vitejs.dev/config for docs")).toBeNull();
    expect(matchDevUrl("compiling...")).toBeNull();
  });
});

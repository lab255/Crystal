import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AnalysisBackend, createCodeMapFacade } from "./analysis-host.js";

const tmpRoots: string[] = [];
const backends: AnalysisBackend[] = [];
afterEach(async () => {
  for (const b of backends.splice(0)) b.dispose();
  for (const root of tmpRoots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function makeProject(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "crystal-analysis-"));
  tmpRoots.push(root);
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(
    path.join(root, "src", "a.ts"),
    "export function alpha() { return beta(); }\nexport function beta() { return 1; }\n",
  );
  return root;
}

describe("AnalysisBackend", () => {
  it("serves codemap calls through the facade (worker or in-process fallback)", async () => {
    const root = await makeProject();
    const backend = new AnalysisBackend(root);
    backends.push(backend);
    const codemap = createCodeMapFacade(backend);

    const detail = await codemap.fileDetail("src/a.ts");
    expect(detail.symbols.map((s) => s.name)).toContain("alpha");
    // Whichever mode it landed in, it must have settled on one.
    expect(["worker", "local"]).toContain(backend.mode);

    // invalidate is fire-and-forget safe and analysis still works after.
    await codemap.invalidate();
    const again = await codemap.fileDetail("src/a.ts");
    expect(again.symbols.map((s) => s.name)).toContain("beta");
  });

  it("rejects calls after dispose", async () => {
    const root = await makeProject();
    const backend = new AnalysisBackend(root);
    const codemap = createCodeMapFacade(backend);
    await codemap.fileDetail("src/a.ts");
    backend.dispose();
    await expect(codemap.fileDetail("src/a.ts")).rejects.toThrow(/disposed/);
  });

  it("facade never looks like a thenable", async () => {
    const root = await makeProject();
    const backend = new AnalysisBackend(root);
    backends.push(backend);
    const codemap = createCodeMapFacade(backend);
    // `await facade` must yield the facade itself, not hang on a fake then().
    const awaited = await codemap;
    expect(awaited).toBe(codemap);
  });
});

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeTemplate, templateScope, type WorkflowTemplate } from "@crystal/core";
import { GlobalTemplateStore, TemplateLibrary } from "./template-library.js";

let dir: string;

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "crystal-templates-"));
});

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

let seq = 0;
function makeLibrary(sharedGlobal?: GlobalTemplateStore) {
  const root = path.join(dir, `lib${(seq += 1)}`);
  const global = sharedGlobal ?? new GlobalTemplateStore(path.join(root, "global"));
  const projectDir = path.join(root, "project");
  return { library: new TemplateLibrary(projectDir, global), global, projectDir, root };
}

function template(name: string, id = ""): WorkflowTemplate {
  return makeTemplate({
    id,
    name,
    stages: [
      { id: "only", name: "Only", purpose: "implement", dependsOn: [], perTrack: false },
    ],
  });
}

describe("TemplateLibrary", () => {
  it("lists built-ins, global and project templates in that order", async () => {
    const { library } = makeLibrary();
    const globalOne = await library.save(template("Shared"), "global");
    const projectOne = await library.save(template("Local"), "project");

    const listed = await library.list();
    const ids = listed.map((t) => t.id);
    expect(ids.slice(0, 3)).toEqual(["simple", "standard", "advanced"]);
    expect(ids.indexOf(globalOne.id)).toBeLessThan(ids.indexOf(projectOne.id));
    expect(listed.find((t) => t.id === globalOne.id)!.scope).toBe("global");
    expect(listed.find((t) => t.id === projectOne.id)!.scope).toBe("project");
  });

  it("blank ids mint one; built-in ids are refused for save and delete", async () => {
    const { library } = makeLibrary();
    const saved = await library.save(template("Fresh"));
    expect(saved.id).toMatch(/^wft_/);

    await expect(library.save({ ...saved, id: "standard" })).rejects.toThrow(/read-only/);
    await expect(library.remove("simple")).rejects.toThrow(/built-in/);
    await expect(library.remove("wft_nope")).rejects.toThrow(/Unknown template/);
  });

  it("invalid graphs never reach disk", async () => {
    const { library, projectDir } = makeLibrary();
    const broken = { ...template("Broken", "wft_broken") };
    broken.stages = [{ ...broken.stages[0]!, dependsOn: ["ghost"] }];
    await expect(library.save(broken)).rejects.toThrow(/unknown stage/);
    expect(await fs.readdir(projectDir).catch(() => [])).toEqual([]);
  });

  /**
   * The failure this guards: saving a project template as global used to
   * leave the project copy in place, so the same id existed in both
   * directories and `get` resolved it by directory precedence rather than by
   * what the user chose.
   */
  it("changing scope moves the template rather than copying it", async () => {
    const { library, root } = makeLibrary();
    const saved = await library.save(template("Movable"), "project");
    const projectFile = path.join(root, "project", `${saved.id}.json`);
    const globalFile = path.join(root, "global", `${saved.id}.json`);
    expect(await exists(projectFile)).toBe(true);

    const promoted = await library.save(saved, "global");
    expect(templateScope(promoted)).toBe("global");
    expect(await exists(globalFile)).toBe(true);
    expect(await exists(projectFile)).toBe(false);
    expect((await library.list()).filter((t) => t.id === saved.id)).toHaveLength(1);

    // ...and back again.
    const demoted = await library.save(promoted, "project");
    expect(templateScope(demoted)).toBe("project");
    expect(await exists(projectFile)).toBe(true);
    expect(await exists(globalFile)).toBe(false);
  });

  it("saving without a scope keeps the template where it already is", async () => {
    const { library } = makeLibrary();
    const global = await library.save(template("Stays global"), "global");
    const resaved = await library.save({ ...global, name: "Renamed" });
    expect(templateScope(resaved)).toBe("global");
    expect((await library.get(global.id))!.name).toBe("Renamed");
  });

  it("a global save is visible to every library sharing the store, and announced", async () => {
    const shared = new GlobalTemplateStore(path.join(dir, `shared${(seq += 1)}`));
    const a = makeLibrary(shared).library;
    const b = makeLibrary(shared).library;
    let notified = 0;
    b.events.on("changed", () => {
      notified += 1;
    });

    const saved = await a.save(template("Everywhere"), "global");
    expect((await b.list()).map((t) => t.id)).toContain(saved.id);
    expect(notified).toBe(1);

    // A project template stays in its own workspace.
    const local = await a.save(template("Just here"), "project");
    expect((await b.list()).map((t) => t.id)).not.toContain(local.id);

    await a.remove(saved.id);
    expect((await b.list()).map((t) => t.id)).not.toContain(saved.id);
    expect(notified).toBe(2);

    // After dispose the library stops hearing about global changes — a
    // closed workspace must not keep announcing into a dead emitter.
    b.dispose();
    await a.save(template("After dispose"), "global");
    expect(notified).toBe(2);
  });

  it("the directory a template sits in wins over the scope written inside it", async () => {
    const { library, root } = makeLibrary();
    // Simulate a file copied out of the global directory by hand.
    const projectDir = path.join(root, "project");
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(
      path.join(projectDir, "wft_copied.json"),
      JSON.stringify({ ...template("Copied", "wft_copied"), scope: "global" }),
      "utf8",
    );
    const found = (await library.list()).find((t) => t.id === "wft_copied");
    expect(found?.scope).toBe("project");
  });

  it("a corrupt file is skipped, not fatal", async () => {
    const { library, root } = makeLibrary();
    const projectDir = path.join(root, "project");
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(path.join(projectDir, "wft_bad.json"), "{ not json", "utf8");
    await fs.writeFile(
      path.join(projectDir, "wft_good.json"),
      JSON.stringify(template("Good", "wft_good")),
      "utf8",
    );
    const ids = (await library.list()).map((t) => t.id);
    expect(ids).toContain("wft_good");
    expect(ids).not.toContain("wft_bad");
  });
});

async function exists(file: string): Promise<boolean> {
  return fs
    .stat(file)
    .then(() => true)
    .catch(() => false);
}

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JsonRecordStore } from "./record-store.js";

interface Rec {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

/** Rejects anything without the four fields — stands in for a zod schema. */
function parseRec(raw: unknown): Rec {
  const r = raw as Partial<Rec>;
  if (!r || typeof r.id !== "string" || typeof r.name !== "string") {
    throw new Error("not a record");
  }
  return { id: r.id, name: r.name, createdAt: r.createdAt ?? "", updatedAt: r.updatedAt ?? "" };
}

describe("JsonRecordStore", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "crystal-records-"));
  });

  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  /** A store over its own subdirectory, plus the changes it announced. */
  function store(
    name: string,
    now = () => "2026-01-01T00:00:00.000Z",
    writeFile?: typeof fs.writeFile,
  ) {
    const changed: Rec[] = [];
    const s = new JsonRecordStore<Rec>(
      path.join(dir, name),
      parseRec,
      (r) => changed.push(r),
      now,
      writeFile,
    );
    return { s, changed, dir: path.join(dir, name) };
  }

  const rec = (id: string, createdAt = "2026-01-01T00:00:00.000Z"): Rec => ({
    id,
    name: id,
    createdAt,
    updatedAt: createdAt,
  });

  it("persists, announces and reloads records", async () => {
    const { s, changed, dir: d } = store("basic");
    await s.put(rec("a"));
    expect(changed.map((r) => r.id)).toEqual(["a"]);
    expect(await fs.readFile(path.join(d, "a.json"), "utf8")).toContain('"id": "a"');

    // A fresh store over the same directory sees it.
    const { s: reopened } = store("basic");
    expect((await reopened.get("a"))?.name).toBe("a");
    expect(await reopened.get("nope")).toBeNull();
  });

  it("skips a corrupt file instead of failing the whole load", async () => {
    const { s, dir: d } = store("corrupt");
    await s.put(rec("good"));
    await fs.writeFile(path.join(d, "bad.json"), "{ not json", "utf8");
    await fs.writeFile(path.join(d, "wrong.json"), JSON.stringify({ nope: true }), "utf8");

    const { s: reopened } = store("corrupt");
    expect((await reopened.list()).map((r) => r.id)).toEqual(["good"]);
  });

  it("stamps updatedAt, persists, then announces — in that order", async () => {
    let clock = 0;
    const { s, changed, dir: d } = store("mutate", () => `t${++clock}`);
    await s.put(rec("a"));

    const seenOnDisk: string[] = [];
    const result = await s.mutate("a", async (record) => {
      // Mid-mutation the file still holds the previous value…
      seenOnDisk.push(JSON.parse(await fs.readFile(path.join(d, "a.json"), "utf8")).name);
      return { record: { ...record, name: "renamed" }, result: "done" };
    });
    expect(result).toBe("done");
    expect(seenOnDisk).toEqual(["a"]);
    // …and by the time the change is announced it is on disk.
    expect(changed.at(-1)).toMatchObject({ name: "renamed", updatedAt: "t1" });
    expect(JSON.parse(await fs.readFile(path.join(d, "a.json"), "utf8")).name).toBe("renamed");
  });

  it("keeps the previous record in memory and on disk when an atomic write fails", async () => {
    const { s: seed, dir: d } = store("atomic-failure");
    await seed.put(rec("a"));

    const failingWrite = (async (file: Parameters<typeof fs.writeFile>[0]) => {
      // Model a crash/failure after bytes reached the temporary file.
      await fs.writeFile(file, "{ truncated", "utf8");
      throw new Error("disk full");
    }) as typeof fs.writeFile;
    const { s } = store("atomic-failure", undefined, failingWrite);
    await expect(
      s.mutate("a", (record) => ({ record: { ...record, name: "lost" }, result: null })),
    ).rejects.toThrow(/disk full/);

    expect((await s.get("a"))?.name).toBe("a");
    const { s: reopened } = store("atomic-failure");
    expect((await reopened.get("a"))?.name).toBe("a");
    expect((await fs.readdir(d)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("serializes concurrent mutations and survives a failing one", async () => {
    const { s } = store("queue");
    await s.put(rec("a"));

    const order: string[] = [];
    const slow = s.mutate("a", async (record) => {
      order.push("start-slow");
      await new Promise((r) => setTimeout(r, 20));
      order.push("end-slow");
      return { record: { ...record, name: `${record.name}+slow` }, result: null };
    });
    const fast = s.mutate("a", async (record) => {
      order.push("start-fast");
      return { record: { ...record, name: `${record.name}+fast` }, result: null };
    });
    await Promise.all([slow, fast]);
    // The second read-modify-write saw the first one's result, not the original.
    expect(order).toEqual(["start-slow", "end-slow", "start-fast"]);
    expect((await s.get("a"))?.name).toBe("a+slow+fast");

    // A rejected mutation surfaces to its caller and leaves the queue usable.
    await expect(
      s.mutate("a", () => {
        throw new Error("nope");
      }),
    ).rejects.toThrow("nope");
    await expect(s.mutate("missing", (r) => ({ record: r, result: null }))).rejects.toThrow(
      /Unknown record/,
    );
    await expect(
      s.mutate("a", (record) => ({ record: { ...record, name: "after" }, result: "ok" })),
    ).resolves.toBe("ok");
  });

  it("lists newest first and forgets a removed record", async () => {
    const { s, dir: d } = store("remove");
    await s.put(rec("old", "2026-01-01T00:00:00.000Z"));
    await s.put(rec("new", "2026-06-01T00:00:00.000Z"));
    expect((await s.list()).map((r) => r.id)).toEqual(["new", "old"]);

    await s.remove("old");
    expect(await s.get("old")).toBeNull();
    expect(s.peek("old")).toBeUndefined();
    expect(s.all().map((r) => r.id)).toEqual(["new"]);
    await expect(fs.access(path.join(d, "old.json"))).rejects.toThrow();
    // Removing something that is already gone is not an error.
    await expect(s.remove("old")).resolves.toBeUndefined();
  });
});

describe("JsonRecordStore invariants under concurrency", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "crystal-records2-"));
  });

  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  function store(name: string) {
    const changed: Rec[] = [];
    const s = new JsonRecordStore<Rec>(
      path.join(dir, name),
      parseRec,
      (r) => changed.push(r),
      () => "t",
    );
    return { s, changed, dir: path.join(dir, name) };
  }

  const rec = (id: string): Rec => ({ id, name: id, createdAt: "c", updatedAt: "c" });

  it("makes concurrent readers wait for the first load, not race past it", async () => {
    const { s: seed, dir: d } = store("load-race");
    await seed.put(rec("a"));

    // A fresh store: two callers arrive together, before anything is read.
    const { s } = store("load-race");
    const [listed, got] = await Promise.all([s.list(), s.get("a")]);
    // A flag flipped before the first await would let one of these through
    // to an empty map — and a settlement arriving in that window is lost.
    expect(listed.map((r) => r.id)).toEqual(["a"]);
    expect(got?.id).toBe("a");
    expect(d).toContain("load-race");
  });

  it("does not touch disk or announce when a mutation changes nothing", async () => {
    const { s, changed, dir: d } = store("noop");
    await s.put(rec("a"));
    const before = await fs.stat(path.join(d, "a.json"));
    changed.length = 0;

    // A refused transition hands back the record it was given.
    const result = await s.mutate("a", (record) => ({ record, result: "refused" }));
    expect(result).toBe("refused");
    expect(changed).toEqual([]);
    expect((await fs.stat(path.join(d, "a.json"))).mtimeMs).toBe(before.mtimeMs);
    expect((await s.get("a"))?.updatedAt).toBe("c");
  });

  it("does not resurrect a record removed while a mutation was in flight", async () => {
    const { s, dir: d } = store("resurrect");
    await s.put(rec("a"));

    // The mutation suspends; the removal lands behind it on the same queue.
    const slow = s.mutate("a", async (record) => {
      await new Promise((r) => setTimeout(r, 20));
      return { record: { ...record, name: "renamed" }, result: null };
    });
    const removal = s.remove("a");
    await Promise.all([slow, removal]);

    expect(await s.get("a")).toBeNull();
    await expect(fs.access(path.join(d, "a.json"))).rejects.toThrow();
  });

  it("keeps records independent — one slow write does not stall another", async () => {
    const { s } = store("independent");
    await Promise.all([s.put(rec("a")), s.put(rec("b"))]);

    const order: string[] = [];
    const slowA = s.mutate("a", async (record) => {
      await new Promise((r) => setTimeout(r, 30));
      order.push("a");
      return { record: { ...record, name: "a2" }, result: null };
    });
    const fastB = s.mutate("b", (record) => {
      order.push("b");
      return { record: { ...record, name: "b2" }, result: null };
    });
    await Promise.all([slowA, fastB]);
    expect(order).toEqual(["b", "a"]);
  });

  it("refuses to persist a record that would not survive a reload", async () => {
    const { s } = store("validate");
    await s.put(rec("a"));
    await expect(
      // `name` is required by the parser; writing this would make the record
      // unloadable — and it would disappear at the next boot.
      s.mutate("a", (record) => ({ record: { ...record, name: undefined as never }, result: null })),
    ).rejects.toThrow(/not a record/);
    expect((await s.get("a"))?.name).toBe("a");
  });
});

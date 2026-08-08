import { describe, expect, it } from "vitest";
import { PendingQueue } from "./pending-queue.js";

describe("PendingQueue", () => {
  it("never calls deliver for an empty key", async () => {
    const q = new PendingQueue<string>();
    let called = 0;
    expect(await q.drain("k", async () => (called++, true))).toBe(false);
    expect(called).toBe(0);
  });

  it("keeps everything queued when delivery reports failure", async () => {
    const q = new PendingQueue<string>();
    q.push("k", "a");
    expect(await q.drain("k", async () => null)).toBe(false);
    expect(q.size("k")).toBe(1);
  });

  it("drops exactly the delivered snapshot — pushes during delivery survive", async () => {
    // The trap every hand-rolled copy guarded individually: a worker settling
    // while the manager resumes must not have its notice swallowed by the
    // flush that was already in flight.
    const q = new PendingQueue<string>();
    q.push("k", "a");
    q.push("k", "b");
    const seen: readonly string[][] = [];
    await q.drain("k", async (items) => {
      (seen as string[][]).push([...items]);
      q.push("k", "late");
      return true;
    });
    expect(seen).toEqual([["a", "b"]]);
    expect(q.size("k")).toBe(1);
    await q.drain("k", async (items) => {
      expect(items).toEqual(["late"]);
      return true;
    });
    expect(q.size("k")).toBe(0);
  });

  it("propagates a rejection with the queue intact", async () => {
    const q = new PendingQueue<string>();
    q.push("k", "a");
    await expect(q.drain("k", async () => Promise.reject(new Error("boom")))).rejects.toThrow(
      "boom",
    );
    expect(q.size("k")).toBe(1);
  });

  it("clear abandons a key without touching the others", () => {
    const q = new PendingQueue<string>();
    q.push("a", "x");
    q.push("b", "y");
    q.clear("a");
    expect(q.size("a")).toBe(0);
    expect(q.size("b")).toBe(1);
  });

  it("moves queued items ahead of anything already waiting on the continuation", () => {
    const q = new PendingQueue<string>();
    q.push("retired", "old-1");
    q.push("retired", "old-2");
    q.push("continuation", "new");
    q.move("retired", "continuation");
    expect(q.items("retired")).toEqual([]);
    expect(q.items("continuation")).toEqual(["old-1", "old-2", "new"]);
  });
});

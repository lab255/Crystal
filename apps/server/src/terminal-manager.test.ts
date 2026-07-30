import { describe, expect, it } from "vitest";
import type { TerminalInfo } from "@crystal/core";
import { TerminalManager, pasteInput, type TerminalSeed } from "./terminal-manager.js";

describe("pasteInput", () => {
  it("wraps text in bracketed-paste markers and submits with a carriage return", () => {
    expect(pasteInput("hello")).toBe("\x1b[200~hello\x1b[201~\r");
  });

  it("keeps embedded newlines inside one paste (no line-by-line submission)", () => {
    // A multi-line agent prompt typed raw would submit at the first \n; as a
    // bracketed paste the TUI treats it as one message.
    const wrapped = pasteInput("line one\nline two");
    expect(wrapped).toBe("\x1b[200~line one\nline two\x1b[201~\r");
    expect(wrapped.indexOf("\r")).toBe(wrapped.length - 1);
  });
});

/** A dead terminal's restorable state, as a previous runtime would hand over. */
function seedOf(id: string): TerminalSeed {
  return {
    info: {
      id,
      cwd: ".",
      shell: "/bin/fake",
      title: null,
      status: "exited",
      exitCode: 0,
      createdAt: new Date().toISOString(),
      cols: 100,
      rows: 30,
    },
    chunks: [
      { terminalId: id, seq: 0, stream: "stdout", text: `scrollback of ${id}\r\n` },
      { terminalId: id, seq: 1, stream: "system", text: "[terminal exited with code 0]\r\n" },
    ],
  };
}

describe("TerminalManager seeding (buffer-preserving reopen)", () => {
  it("seed() then list() shows the seeded terminal, exited, with its buffer intact", () => {
    const mgr = new TerminalManager(process.cwd());
    mgr.seed([seedOf("term-restored-1")]);

    const listed = mgr.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: "term-restored-1", status: "exited", exitCode: 0 });
    expect(mgr.buffer("term-restored-1").map((c) => c.text)).toEqual([
      "scrollback of term-restored-1\r\n",
      "[terminal exited with code 0]\r\n",
    ]);
  });

  it("seed() never overwrites an existing record with the same id", () => {
    const mgr = new TerminalManager(process.cwd());
    mgr.seed([seedOf("term-dup")]);
    const clash = seedOf("term-dup");
    clash.chunks = [{ terminalId: "term-dup", seq: 0, stream: "stdout", text: "other\r\n" }];
    mgr.seed([clash]);
    expect(mgr.list()).toHaveLength(1);
    expect(mgr.buffer("term-dup")[0]!.text).toBe("scrollback of term-dup\r\n");
  });

  it("kill() of a seeded (exited, no-pty) record deletes it and emits changed", async () => {
    const mgr = new TerminalManager(process.cwd());
    mgr.seed([seedOf("term-restored-2")]);
    const changed: TerminalInfo[] = [];
    mgr.events.on("changed", ({ terminal }) => changed.push(terminal));

    await mgr.kill("term-restored-2");

    expect(mgr.list()).toEqual([]);
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({ id: "term-restored-2", status: "exited" });
    await expect(mgr.kill("term-restored-2")).rejects.toThrow(/Unknown terminal/);
  });

  it("disposeAll() resolves, clears the list, and returns the dead records for reseeding", async () => {
    const mgr = new TerminalManager(process.cwd());
    mgr.seed([seedOf("term-a"), seedOf("term-b")]);

    const seeds = await mgr.disposeAll();

    expect(mgr.list()).toEqual([]);
    expect(seeds.map((s) => s.info.id).sort()).toEqual(["term-a", "term-b"]);
    expect(seeds.every((s) => s.info.status === "exited")).toBe(true);
    // Round-trip: a fresh manager seeded from the snapshot serves the same buffers.
    const next = new TerminalManager(process.cwd());
    next.seed(seeds);
    expect(next.buffer("term-a")[0]!.text).toBe("scrollback of term-a\r\n");
  });
});

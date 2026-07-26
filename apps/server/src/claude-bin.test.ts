import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { envWithBinDir, isBareName, resolveClaudeBin } from "./claude-bin.js";

const tmps: string[] = [];

afterEach(async () => {
  await Promise.all(tmps.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

async function tmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "crystal-claude-bin-"));
  tmps.push(dir);
  return dir;
}

/** Drop an executable-looking file into `dir` and return its path. */
async function fakeBin(dir: string, name: string): Promise<string> {
  const file = path.join(dir, name);
  await fs.writeFile(file, "#!/bin/sh\n", { mode: 0o755 });
  return file;
}

const noShell = () => Promise.resolve(null);

describe("resolveClaudeBin", () => {
  it("passes explicit paths and extension-carrying names through untouched", async () => {
    for (const bin of ["C:\\tools\\claude.exe", "/usr/local/bin/claude", "claude.cmd", "./claude"]) {
      expect(await resolveClaudeBin(bin, { shellLookup: noShell })).toBe(bin);
      expect(isBareName(bin)).toBe(false);
    }
  });

  it("finds a bare name on the provided PATH", async () => {
    const dir = await tmpDir();
    const bin = await fakeBin(dir, "claude");
    const resolved = await resolveClaudeBin("claude", {
      env: { PATH: `${await tmpDir()}${path.delimiter}${dir}` },
      home: await tmpDir(),
      platform: "darwin",
      shellLookup: noShell,
    });
    expect(resolved).toBe(bin);
  });

  it("prefers .exe over .cmd within one Windows PATH dir", async () => {
    const dir = await tmpDir();
    await fakeBin(dir, "claude.cmd");
    const exe = await fakeBin(dir, "claude.exe");
    const resolved = await resolveClaudeBin("claude", {
      env: { Path: dir },
      home: await tmpDir(),
      platform: "win32",
      shellLookup: noShell,
    });
    expect(resolved).toBe(exe);
  });

  it("falls back to well-known install dirs when PATH misses (GUI launch)", async () => {
    // The desktop sidecar's launchd/Explorer PATH has no claude at all — the
    // native installer's ~/.local/bin must still be found.
    const home = await tmpDir();
    const local = path.join(home, ".local", "bin");
    await fs.mkdir(local, { recursive: true });
    const bin = await fakeBin(local, "claude");
    const resolved = await resolveClaudeBin("claude", {
      env: { PATH: "/usr/bin:/bin" },
      home,
      platform: "darwin",
      shellLookup: noShell,
    });
    expect(resolved).toBe(bin);
  });

  it("asks the login shell last, and survives it finding nothing", async () => {
    const home = await tmpDir();
    const asked: string[] = [];
    const resolved = await resolveClaudeBin("claude", {
      env: { PATH: "/nowhere" },
      home,
      platform: "darwin",
      shellLookup: async (bin) => {
        asked.push(bin);
        return "/from/login/shell/claude";
      },
    });
    expect(resolved).toBe("/from/login/shell/claude");
    expect(asked).toEqual(["claude"]);
    // Everything missing → the bare name survives so the spawn fails as a
    // legible failed run instead of the server crashing or hanging.
    expect(
      await resolveClaudeBin("claude", {
        env: { PATH: "/nowhere" },
        home,
        platform: "darwin",
        shellLookup: noShell,
      }),
    ).toBe("claude");
  });

  it("never consults the login shell on Windows", async () => {
    let asked = false;
    const resolved = await resolveClaudeBin("claude", {
      env: { Path: "C:\\nowhere" },
      home: await tmpDir(),
      platform: "win32",
      shellLookup: async () => {
        asked = true;
        return "C:\\shell\\claude.exe";
      },
    });
    expect(resolved).toBe("claude");
    expect(asked).toBe(false);
  });
});

describe("envWithBinDir", () => {
  it("prepends the binary's dir to PATH", () => {
    const env = envWithBinDir(
      { PATH: `/usr/bin${path.delimiter}/bin` },
      "/opt/homebrew/bin/claude",
    );
    expect(env.PATH).toBe(`/opt/homebrew/bin${path.delimiter}/usr/bin${path.delimiter}/bin`);
  });

  it("reuses the env's existing Path key instead of adding a case-colliding PATH", () => {
    // Windows: `{ ...env, PATH }` beside an inherited `Path` puts two keys
    // differing only in case into the env block — which one the child sees
    // is undefined.
    const env = envWithBinDir({ Path: "C:\\Windows" }, "C:\\Users\\x\\.local\\bin\\claude.exe");
    expect(env.Path).toBe(`C:\\Users\\x\\.local\\bin${path.delimiter}C:\\Windows`);
    expect(Object.keys(env)).toEqual(["Path"]);
  });

  it("leaves the env alone for a relative binary or an already-listed dir", () => {
    const base = { PATH: `/a${path.delimiter}/b` };
    expect(envWithBinDir(base, "claude")).toBe(base);
    expect(envWithBinDir(base, "/a/claude")).toBe(base);
  });
});

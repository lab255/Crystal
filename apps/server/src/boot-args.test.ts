import { describe, expect, it } from "vitest";
import { noDefaultRoot, resolveStartupRoots } from "./boot-args.js";

const CWD = "/tmp/cwd";
const NODE = ["node", "index.js"];

describe("resolveStartupRoots", () => {
  it("takes every --root, in order", () => {
    expect(resolveStartupRoots([...NODE, "--root", "/a", "--root", "/b"], {}, CWD)).toEqual([
      "/a",
      "/b",
    ]);
  });

  it("falls back to the cwd when no root is given", () => {
    expect(resolveStartupRoots([...NODE, "--listen", "127.0.0.1:4517"], {}, CWD)).toEqual([CWD]);
  });

  it("drops the cwd fallback under --no-default-root", () => {
    expect(resolveStartupRoots([...NODE, "--no-default-root"], {}, CWD)).toEqual([]);
  });

  it("drops the cwd fallback under CRYSTAL_NO_DEFAULT_ROOT=1", () => {
    expect(resolveStartupRoots([...NODE], { CRYSTAL_NO_DEFAULT_ROOT: "1" }, CWD)).toEqual([]);
  });

  it("still honors an explicit --root alongside the flag (the flag only kills the fallback)", () => {
    expect(resolveStartupRoots([...NODE, "--no-default-root", "--root", "/a"], {}, CWD)).toEqual([
      "/a",
    ]);
  });

  it("ignores a trailing --root with no value", () => {
    expect(resolveStartupRoots([...NODE, "--root"], { CRYSTAL_NO_DEFAULT_ROOT: "1" }, CWD)).toEqual(
      [],
    );
  });
});

describe("noDefaultRoot", () => {
  it("is off by default and for any non-'1' env value", () => {
    expect(noDefaultRoot(NODE, {})).toBe(false);
    expect(noDefaultRoot(NODE, { CRYSTAL_NO_DEFAULT_ROOT: "0" })).toBe(false);
    expect(noDefaultRoot(NODE, { CRYSTAL_NO_DEFAULT_ROOT: "" })).toBe(false);
  });
});

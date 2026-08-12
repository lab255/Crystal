import { describe, expect, it } from "vitest";
import { codexExecArgs, codexFallbackDirs, codexInteractiveArgs, codexSandboxArgs } from "./codex.js";

describe("codexSandboxArgs", () => {
  it("maps Crystal permission modes onto codex sandbox levels", () => {
    expect(codexSandboxArgs("default")).toEqual(["--sandbox", "read-only"]);
    expect(codexSandboxArgs("plan")).toEqual(["--sandbox", "read-only"]);
    expect(codexSandboxArgs("acceptEdits")).toEqual(["--sandbox", "workspace-write"]);
    expect(codexSandboxArgs(null)).toEqual(["--sandbox", "workspace-write"]);
    expect(codexSandboxArgs("bypassPermissions")).toEqual(["--sandbox", "danger-full-access"]);
  });
});

describe("codexExecArgs", () => {
  it("builds a headless invocation with the prompt on stdin", () => {
    expect(codexExecArgs({ model: "gpt-5.2-codex" })).toEqual([
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--sandbox",
      "workspace-write",
      "--model",
      "gpt-5.2-codex",
      "-",
    ]);
  });

  it("resumes a thread via `exec resume <id>` before the flags", () => {
    const args = codexExecArgs({ resumeSessionId: "th_9", permissionMode: "plan" });
    expect(args.slice(0, 3)).toEqual(["exec", "resume", "th_9"]);
    expect(args).toContain("--json");
    expect(args[args.length - 1]).toBe("-");
  });
});

describe("codexInteractiveArgs", () => {
  it("emits no --json and no session pinning (the TUI owns both)", () => {
    const args = codexInteractiveArgs({ model: "gpt-5.2", permissionMode: "acceptEdits" });
    expect(args).toEqual(["--sandbox", "workspace-write", "--model", "gpt-5.2"]);
  });

  it("places resume options before the positional session id", () => {
    expect(
      codexInteractiveArgs({
        model: "gpt-5.2-codex",
        resumeSessionId: "th_9",
        permissionMode: "plan",
      }),
    ).toEqual(["resume", "--sandbox", "read-only", "--model", "gpt-5.2-codex", "th_9"]);
  });
});

describe("codexFallbackDirs", () => {
  it("covers npm-global, cargo and volta homes on win32", () => {
    const dirs = codexFallbackDirs("win32", "C:\\Users\\t", {
      APPDATA: "C:\\Users\\t\\AppData\\Roaming",
      LOCALAPPDATA: "C:\\Users\\t\\AppData\\Local",
    });
    expect(dirs.some((d) => d.includes("npm"))).toBe(true);
    expect(dirs.some((d) => d.includes(".cargo"))).toBe(true);
    expect(dirs.some((d) => d.includes("Volta"))).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { formatDeepLink, parseDeepLink, type DeepLink } from "./deeplink.js";

const roundTrip = (link: DeepLink) => parseDeepLink(formatDeepLink(link));

describe("formatDeepLink", () => {
  it("returns empty string without a mode", () => {
    expect(formatDeepLink({})).toBe("");
    expect(formatDeepLink({ ws: "abc" })).toBe("");
  });

  it("keeps slashes in paths readable", () => {
    const hash = formatDeepLink({
      mode: "code",
      ws: "abc",
      code: { file: "packages/core/src/index.ts" },
    });
    expect(hash).toBe("#/code?ws=abc&file=packages/core/src/index.ts");
  });

  it("emits only the active mode's params", () => {
    const hash = formatDeepLink({
      mode: "code",
      architect: { diagram: "x.crystal" },
      orchestrate: { task: "t1" },
      code: {},
    });
    expect(hash).toBe("#/code");
  });

  it("omits the code-map workspace when it matches the active one", () => {
    const hash = formatDeepLink({
      mode: "architect",
      ws: "abc",
      architect: { view: "codemap", codemap: { kind: "module", ws: "abc", path: "packages/ui" } },
    });
    expect(hash).toBe("#/architect/codemap?ws=abc&at=module&path=packages/ui");
    const other = formatDeepLink({
      mode: "architect",
      ws: "abc",
      architect: { view: "codemap", codemap: { kind: "workspace", ws: "def" } },
    });
    expect(other).toBe("#/architect/codemap?ws=abc&at=workspace&mws=def");
  });

  it("scopes task/run params to their tab", () => {
    expect(
      formatDeepLink({ mode: "orchestrate", orchestrate: { tab: "board", task: "t1", run: "r1" } }),
    ).toBe("#/orchestrate/board?task=t1");
    expect(
      formatDeepLink({ mode: "orchestrate", orchestrate: { tab: "runs", task: "t1", run: "r1" } }),
    ).toBe("#/orchestrate/runs?run=r1");
  });
});

describe("parseDeepLink", () => {
  it("tolerates garbage", () => {
    expect(parseDeepLink("")).toEqual({});
    expect(parseDeepLink("#")).toEqual({});
    expect(parseDeepLink("#/nonsense/deep?x=1")).toEqual({});
    expect(parseDeepLink("#/architect/bogusview")).toEqual({ mode: "architect" });
  });

  it("ignores incomplete code-map levels", () => {
    // module level without a path
    expect(parseDeepLink("#/architect/codemap?ws=a&at=module").architect?.codemap).toBeUndefined();
    // workspace level without any workspace id
    expect(parseDeepLink("#/architect/codemap?at=workspace").architect?.codemap).toBeUndefined();
  });

  it("defaults the code-map workspace to the active ws param", () => {
    const link = parseDeepLink("#/architect/codemap?ws=abc&at=file&path=src/a.ts");
    expect(link.architect?.codemap).toEqual({ kind: "file", ws: "abc", path: "src/a.ts" });
  });

  it("accepts hashes without the leading #", () => {
    expect(parseDeepLink("/code?file=a.ts")).toEqual({ mode: "code", code: { file: "a.ts" } });
  });
});

describe("round trips", () => {
  it("architect diagrams with everything set", () => {
    const link: DeepLink = {
      ws: "1a2b3c4d5e6f",
      mode: "architect",
      architect: {
        view: "diagrams",
        diagram: ".crystal/architecture/my api.crystal",
        draft: ".crystal/arch-drafts/plan&1.crystal",
        journey: "j-1",
        overlay: true,
      },
    };
    expect(roundTrip(link)).toEqual(link);
  });

  it("draft review round-trips, and review without a draft is dropped", () => {
    const link: DeepLink = {
      ws: "abc",
      mode: "architect",
      architect: { view: "diagrams", draft: ".crystal/architecture/drafts/plan.json", review: true },
    };
    expect(roundTrip(link)).toEqual(link);
    // review is a lens on a draft — meaningless (and omitted) without one
    expect(formatDeepLink({ mode: "architect", architect: { review: true } })).toBe("#/architect/diagrams");
    expect(parseDeepLink("#/architect/diagrams?review=1").architect?.review).toBeUndefined();
  });

  it("architect infra keeps the shared diagram selection", () => {
    const link: DeepLink = {
      ws: "abc",
      mode: "architect",
      architect: { view: "infra", diagram: "a.crystal" },
    };
    expect(roundTrip(link)).toEqual(link);
  });

  it("code map levels", () => {
    for (const codemap of [
      { kind: "all" } as const,
      { kind: "workspace", ws: "abc" } as const,
      { kind: "module", ws: "def", path: "packages/core" } as const,
      { kind: "file", ws: "abc", path: "packages/core/src/bridge.ts" } as const,
    ]) {
      const link: DeepLink = {
        ws: "abc",
        mode: "architect",
        architect: { view: "codemap", codemap, duplicates: true },
      };
      expect(roundTrip(link)).toEqual(link);
    }
  });

  it("orchestrate board and runs", () => {
    const board: DeepLink = {
      ws: "abc",
      mode: "orchestrate",
      orchestrate: { tab: "board", project: ".crystal/projects/q3 work.crystal", task: "t-9" },
    };
    expect(roundTrip(board)).toEqual(board);
    const runs: DeepLink = {
      ws: "abc",
      mode: "orchestrate",
      orchestrate: { tab: "runs", run: "run-123" },
    };
    expect(roundTrip(runs)).toEqual(runs);
  });

  it("projects overview", () => {
    const link: DeepLink = { ws: "abc", mode: "projects" };
    expect(formatDeepLink(link)).toBe("#/projects?ws=abc");
    expect(roundTrip(link)).toEqual(link);
  });

  it("editor file with special characters", () => {
    const link: DeepLink = {
      ws: "abc",
      mode: "code",
      code: { file: "src/weird name/#hash&amp?.ts" },
    };
    expect(roundTrip(link)).toEqual(link);
  });

  it("format is canonical for equal links", () => {
    const a = formatDeepLink({ mode: "code", ws: "w", code: { file: "x.ts" } });
    const b = formatDeepLink(parseDeepLink(a));
    expect(b).toBe(a);
  });
});

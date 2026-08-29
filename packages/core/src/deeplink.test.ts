import { describe, expect, it } from "vitest";
import {
  DEFAULT_SERVER_SID,
  applyDeepLink,
  deepLinkNavIdentity,
  formatDeepLink,
  formatWsRef,
  parseDeepLink,
  parseWsRef,
  type DeepLink,
} from "./deeplink.js";

const roundTrip = (link: DeepLink) => parseDeepLink(formatDeepLink(link));

describe("parseWsRef/formatWsRef", () => {
  it("round-trips a default-server ref as a bare id (backward compatible)", () => {
    const ref = formatWsRef(DEFAULT_SERVER_SID, "1a2b3c4d5e6f");
    expect(ref).toBe("1a2b3c4d5e6f");
    expect(parseWsRef(ref)).toEqual({ sid: DEFAULT_SERVER_SID, ws: "1a2b3c4d5e6f" });
  });

  it("treats null/undefined sid as the default server", () => {
    expect(formatWsRef(null, "abc")).toBe("abc");
    expect(formatWsRef(undefined, "abc")).toBe("abc");
  });

  it("round-trips an added-server ref through the sid:wsId form", () => {
    const ref = formatWsRef("s1f3a9c2b", "1a2b3c4d5e6f");
    expect(ref).toBe("s1f3a9c2b:1a2b3c4d5e6f");
    expect(parseWsRef(ref)).toEqual({ sid: "s1f3a9c2b", ws: "1a2b3c4d5e6f" });
  });

  it("parses every pre-fleet URL's bare ws id identically", () => {
    // Old links carry exactly the bare hash — they must mean the default server.
    expect(parseWsRef("d41d8cd98f00")).toEqual({ sid: DEFAULT_SERVER_SID, ws: "d41d8cd98f00" });
  });

  it("keeps the ws param backward compatible inside full deep links", () => {
    const old = parseDeepLink("#/code?ws=abc123&file=src/index.ts");
    expect(old.ws).toBe("abc123");
    const fleet = parseDeepLink("#/code?ws=s99ff0011%3Aabc123&file=src/index.ts");
    expect(fleet.ws).toBe("s99ff0011:abc123");
    expect(parseWsRef(fleet.ws!)).toEqual({ sid: "s99ff0011", ws: "abc123" });
  });

  it("compares code-map workspaces bare-to-bare when link.ws carries a sid", () => {
    // The active workspace lives on an added server, and the code map drills
    // into that same workspace: no mws must be emitted.
    const hash = formatDeepLink({
      mode: "architect",
      ws: "sffee1122:abc",
      architect: { view: "codebase", codemap: { kind: "module", ws: "abc", path: "packages/ui" } },
    });
    expect(hash).not.toContain("mws");
    const parsed = parseDeepLink(hash);
    expect(parsed.architect?.codemap).toEqual({ kind: "module", ws: "abc", path: "packages/ui" });
  });
});

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
      threads: { thread: "r1" },
      code: {},
    });
    expect(hash).toBe("#/code");
  });

  it("defaults the architect view to architecture — what ArchitectMode renders when unset", () => {
    expect(formatDeepLink({ mode: "architect" })).toBe("#/architect/architecture");
    // Params set before the user ever touches the view switcher land on the
    // architecture branch, not silently dropped by another view's default.
    expect(formatDeepLink({ mode: "architect", architect: { system: "sys:auth" } })).toBe(
      "#/architect/architecture?system=sys%3Aauth",
    );
  });

  it("omits the code-map workspace when it matches the active one", () => {
    const hash = formatDeepLink({
      mode: "architect",
      ws: "abc",
      architect: { view: "codebase", codemap: { kind: "module", ws: "abc", path: "packages/ui" } },
    });
    expect(hash).toBe("#/architect/codebase?ws=abc&at=module&path=packages/ui");
    const other = formatDeepLink({
      mode: "architect",
      ws: "abc",
      architect: { view: "codebase", codemap: { kind: "workspace", ws: "def" } },
    });
    expect(other).toBe("#/architect/codebase?ws=abc&at=workspace&mws=def");
  });

  it("round-trips the threads section", () => {
    const url = formatDeepLink({
      mode: "threads",
      ws: "abc",
      threads: { thread: "r1", find: "auth", compose: true },
    });
    expect(url).toBe("#/threads?ws=abc&thread=r1&find=auth&compose=1");
    expect(parseDeepLink(url)).toEqual({
      mode: "threads",
      ws: "abc",
      threads: { thread: "r1", find: "auth", compose: true },
    });
    expect(formatDeepLink({ mode: "threads" })).toBe("#/threads");
  });

  it("round-trips the overview new-program composer", () => {
    const link: DeepLink = {
      mode: "projects",
      projects: { view: "threads", compose: true },
    };
    expect(formatDeepLink(link)).toBe("#/projects/threads?compose=1");
    expect(parseDeepLink(formatDeepLink(link))).toEqual(link);
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
  it("round-trips infra environment, scope, and selection state", () => {
    for (const architect of [
      { view: "infra" as const, env: "env:prod" },
      { view: "infra" as const, scope: "all" },
      { view: "infra" as const, env: "env:prod", sel: "target:t1" },
    ]) {
      expect(roundTrip({ mode: "architect", architect })).toEqual({ mode: "architect", architect });
    }
    expect(parseDeepLink("#/architect/infra").architect).toEqual({ view: "infra" });
  });

  it("keeps C4 scope partitioned from infra scope", () => {
    expect(parseDeepLink("#/architect/architecture?level=components&scope=ctr%3Aapi").architect?.scope).toBe("ctr:api");
    expect(parseDeepLink("#/architect?level=components&scope=ctr%3Aapi").architect?.scope).toBe("ctr:api");
    expect(parseDeepLink("#/architect/infra?scope=ctr%3Aapi").architect?.scope).toBeUndefined();
    expect(deepLinkNavIdentity({ mode: "architect", architect: { view: "infra", scope: "all" } })).toBe("architect/infra/all");
  });

  it("legacy diagrams links land on the architecture view with their state intact", () => {
    const parsed = parseDeepLink(
      "#/architect/diagrams?ws=1a2b3c4d5e6f&diagram=.crystal/architecture/my%20api.crystal&facet=facet-auth1&draft=.crystal/arch-drafts/plan%261.crystal&journey=j-1&overlay=1",
    );
    expect(parsed).toEqual({
      ws: "1a2b3c4d5e6f",
      mode: "architect",
      architect: {
        view: "architecture",
        diagram: ".crystal/architecture/my api.crystal",
        facet: "facet-auth1",
        draft: ".crystal/arch-drafts/plan&1.crystal",
        journey: "j-1",
        overlay: true,
      },
    });
  });

  it("api explorer selection round-trips (surfaces mode)", () => {
    const link: DeepLink = {
      ws: "abc",
      mode: "surfaces",
      surfaces: { view: "apis", system: "sys:submission", api: "POST /api/v3/forms/:formId" },
    };
    expect(roundTrip(link)).toEqual(link);
  });

  it("saved API requests round-trip in apis and legacy client links normalize", () => {
    const link: DeepLink = {
      ws: "abc",
      mode: "surfaces",
      surfaces: { view: "apis", request: "req_123" },
    };
    expect(roundTrip(link)).toEqual(link);
    expect(parseDeepLink("#/surfaces/client?ws=abc&request=req_123")).toEqual(link);
    expect(formatDeepLink(parseDeepLink("#/surfaces/client?request=req_123"))).toBe(
      "#/surfaces/apis?request=req_123",
    );
  });

  it("legacy architect/apis links redirect to the surfaces API explorer", () => {
    const link = parseDeepLink(
      "#/architect/apis?ws=abc&system=sys%3Asubmission&api=POST%20/api/v3/forms/%3AformId",
    );
    expect(link).toEqual({
      ws: "abc",
      mode: "surfaces",
      surfaces: { view: "apis", system: "sys:submission", api: "POST /api/v3/forms/:formId" },
    });
  });

  it("global find travels on every architect subview", () => {
    for (const view of ["architecture", "infra", "codebase"] as const) {
      const link: DeepLink = {
        ws: "abc",
        mode: "architect",
        architect: { view, find: "payment api" },
      };
      expect(roundTrip(link)).toEqual(link);
    }
  });

  it("draft review round-trips, and review without a draft is dropped", () => {
    const link: DeepLink = {
      ws: "abc",
      mode: "architect",
      architect: { view: "architecture", draft: ".crystal/architecture/drafts/plan.json", review: true },
    };
    expect(roundTrip(link)).toEqual(link);
    // review is a lens on a draft — meaningless (and omitted) without one
    expect(
      formatDeepLink({ mode: "architect", architect: { view: "architecture", review: true } }),
    ).toBe("#/architect/architecture");
    expect(parseDeepLink("#/architect/architecture?review=1").architect?.review).toBeUndefined();
  });

  it("legacy ?diagram= links parse for the facet resolver but are never re-emitted", () => {
    const parsed = parseDeepLink("#/architect/infra?ws=abc&diagram=a.crystal");
    expect(parsed.architect?.diagram).toBe("a.crystal");
    expect(
      formatDeepLink({ ws: "abc", mode: "architect", architect: { view: "infra" } }),
    ).toBe("#/architect/infra?ws=abc");
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
        architect: { view: "codebase", codemap, duplicates: true },
      };
      expect(roundTrip(link)).toEqual(link);
    }
  });

  it("code map level of detail and the global lens", () => {
    const link: DeepLink = {
      ws: "abc",
      lens: "intent:auth,intent:payments",
      mode: "architect",
      architect: {
        view: "codebase",
        codemap: { kind: "workspace", ws: "abc" },
        lod: "members",
      },
    };
    expect(roundTrip(link)).toEqual(link);
    expect(formatDeepLink(link)).toBe(
      "#/architect/codebase?ws=abc&lens=intent%3Aauth,intent%3Apayments&at=workspace&lod=members",
    );
  });

  it("global lens travels with every mode", () => {
    const surfaces: DeepLink = {
      ws: "abc",
      lens: "diff:worktree",
      mode: "surfaces",
      surfaces: { view: "apis" },
    };
    expect(roundTrip(surfaces)).toEqual(surfaces);
    expect(formatDeepLink(surfaces)).toBe("#/surfaces/apis?ws=abc&lens=diff%3Aworktree");
    const quality: DeepLink = {
      ws: "abc",
      lens: "facet:f1",
      mode: "quality",
      quality: { view: "tests" },
    };
    expect(roundTrip(quality)).toEqual(quality);
  });

  it("old architect-local lens URLs parse into the global lens", () => {
    const parsed = parseDeepLink("#/architect/codemap?ws=abc&at=workspace&lens=intent%3Aauth");
    expect(parsed.lens).toBe("intent:auth");
  });

  it("code map lens context toggle", () => {
    const link: DeepLink = {
      ws: "abc",
      lens: "intent:auth",
      mode: "architect",
      architect: {
        view: "codebase",
        codemap: { kind: "workspace", ws: "abc" },
        lensCtx: true,
      },
    };
    expect(roundTrip(link)).toEqual(link);
    expect(formatDeepLink(link)).toBe(
      "#/architect/codebase?ws=abc&lens=intent%3Aauth&at=workspace&lensctx=1",
    );
    // off = omitted entirely
    expect(formatDeepLink({ ...link, architect: { ...link.architect, lensCtx: false } })).toBe(
      "#/architect/codebase?ws=abc&lens=intent%3Aauth&at=workspace",
    );
    expect(parseDeepLink("#/architect/codemap?ws=abc&at=workspace").architect?.lensCtx).toBeUndefined();
  });

  it("system focus selection with the global lens", () => {
    const link: DeepLink = {
      ws: "abc",
      lens: "intent:auth",
      mode: "architect",
      architect: {
        view: "architecture",
        system: "sys:auth",
      },
    };
    expect(roundTrip(link)).toEqual(link);
    expect(formatDeepLink(link)).toBe(
      "#/architect/architecture?ws=abc&lens=intent%3Aauth&system=sys%3Aauth",
    );
  });

  it("architecture lens context toggle (system-id lens)", () => {
    const link: DeepLink = {
      ws: "abc",
      lens: "sys:auth",
      mode: "architect",
      architect: {
        view: "architecture",
        lensCtx: true,
      },
    };
    expect(roundTrip(link)).toEqual(link);
    expect(formatDeepLink(link)).toBe(
      "#/architect/architecture?ws=abc&lens=sys%3Aauth&lensctx=1",
    );
    // lensCtx without a lens is meaningless — not emitted
    expect(
      formatDeepLink({
        ws: "abc",
        mode: "architect",
        architect: { view: "architecture", lensCtx: true },
      }),
    ).toBe("#/architect/architecture?ws=abc");
  });

  it("drops an unknown lod value instead of propagating it", () => {
    expect(parseDeepLink("#/architect/codemap?ws=a&at=workspace&lod=galaxy").architect?.lod).toBeUndefined();
  });

  it("pinned highlight travels on every architect subview", () => {
    const diagrams: DeepLink = {
      ws: "abc",
      mode: "architect",
      architect: { view: "architecture", sel: "sym:packages/core/src/booking.ts#createBooking" },
    };
    expect(roundTrip(diagrams)).toEqual(diagrams);
    const codemap: DeepLink = {
      ws: "abc",
      mode: "architect",
      architect: { view: "codebase", codemap: { kind: "workspace", ws: "abc" }, sel: "mod:packages/core" },
    };
    expect(roundTrip(codemap)).toEqual(codemap);
  });

  it("threads selection round-trips", () => {
    const link: DeepLink = {
      ws: "abc",
      mode: "threads",
      threads: { thread: "run-123" },
    };
    expect(roundTrip(link)).toEqual(link);
  });

  it("orchestrate URLs are permanent parse aliases onto threads", () => {
    // Any run-carrying tab lands on its thread — the chain resolves the id.
    for (const tab of ["board", "sessions", "runs", "agents"]) {
      expect(parseDeepLink(`#/orchestrate/${tab}?ws=abc&run=run-123`)).toEqual({
        ws: "abc",
        mode: "threads",
        threads: { thread: "run-123" },
      });
    }
    // Board/workflow selections have no surviving surface — bare threads.
    expect(parseDeepLink("#/orchestrate/board?project=p.crystal&task=t-9")).toEqual({
      mode: "threads",
    });
    expect(parseDeepLink("#/orchestrate/workflows?workflow=w1&builder=1")).toEqual({
      mode: "threads",
    });
    // Costs/insights land on the Overview dashboard (FleetPulse survives).
    expect(parseDeepLink("#/orchestrate/costs?by=epic")).toEqual({ mode: "projects" });
    expect(parseDeepLink("#/orchestrate/insights?period=90")).toEqual({ mode: "projects" });
    // Guessable names keep landing somewhere sensible.
    expect(parseDeepLink("#/sessions").mode).toBe("threads");
    expect(parseDeepLink("#/runs").mode).toBe("threads");
    expect(parseDeepLink("#/chats").mode).toBe("threads");
  });

  it("projects overview", () => {
    const link: DeepLink = { ws: "abc", mode: "projects" };
    expect(formatDeepLink(link)).toBe("#/projects?ws=abc");
    expect(roundTrip(link)).toEqual(link);
  });

  it("jobs hub", () => {
    const link: DeepLink = { ws: "abc", mode: "jobs" };
    expect(formatDeepLink(link)).toBe("#/jobs?ws=abc");
    expect(roundTrip(link)).toEqual(link);
  });

  it("overview threads carry thread, program, manager turn, and filter", () => {
    const link: DeepLink = {
      ws: "abc",
      mode: "projects",
      projects: { view: "threads", thread: "s1/w1/r1", program: "prog_1", turn: "run_2", find: "sso" },
    };
    expect(formatDeepLink(link)).toBe(
      "#/projects/threads?ws=abc&thread=s1/w1/r1&program=prog_1&turn=run_2&find=sso",
    );
    expect(roundTrip(link)).toEqual(link);
  });

  it("the inbox carries only the filter", () => {
    // Program selection belongs to the chat view; an inbox URL that carried
    // it would resurrect a stale selection on back/forward.
    const link: DeepLink = { mode: "projects", projects: { view: "inbox", find: "api" } };
    expect(formatDeepLink(link)).toBe("#/projects/inbox?find=api");
    expect(roundTrip(link)).toEqual(link);
    expect(formatDeepLink({ mode: "projects", projects: { view: "inbox", program: "prog_1" } })).toBe(
      "#/projects/inbox",
    );
    expect(formatDeepLink({ mode: "projects", projects: { view: "inbox", turn: "run_2" } })).toBe(
      "#/projects/inbox",
    );
    expect(parseDeepLink("#/projects/inbox?turn=run_2").projects?.turn).toBeUndefined();
  });

  it("defaults the overview to the dashboard and aliases old hub links", () => {
    expect(formatDeepLink({ mode: "projects" })).toBe("#/projects");
    expect(parseDeepLink("#/projects").mode).toBe("projects");
    expect(parseDeepLink("#/projects/bogus").projects).toBeUndefined();
    // The hub merged into the Overview: its old links are permanent aliases.
    expect(parseDeepLink("#/hub")).toEqual({ mode: "projects", projects: { view: "threads" } });
    expect(parseDeepLink("#/hub/programs?program=prog_1")).toEqual({
      mode: "projects",
      projects: { view: "threads", program: "prog_1" },
    });
    expect(parseDeepLink("#/hub/questions")).toEqual({
      mode: "projects",
      projects: { view: "inbox" },
    });
    expect(parseDeepLink("#/hub/projects").projects).toBeUndefined();
  });

  it("keeps projects/chat as a permanent parse alias and never formats it", () => {
    expect(parseDeepLink("#/projects/chat?program=p1&turn=r2")).toEqual({
      mode: "projects",
      projects: { view: "threads", program: "p1", turn: "r2" },
    });
    expect(formatDeepLink({ mode: "projects", projects: { view: "chat", program: "p1" } }))
      .toBe("#/projects/threads?program=p1");
  });

  it("surfaces subviews round-trip their selections", () => {
    const screens: DeepLink = {
      ws: "abc",
      mode: "surfaces",
      surfaces: { view: "screens", screen: "next-app:/forms/:formId", demo: true, find: "form" },
    };
    expect(roundTrip(screens)).toEqual(screens);
    const components: DeepLink = {
      ws: "abc",
      mode: "surfaces",
      surfaces: { view: "components", component: "src/components/Button.tsx#Button" },
    };
    expect(roundTrip(components)).toEqual(components);
    const stories: DeepLink = {
      ws: "abc",
      mode: "surfaces",
      surfaces: { view: "stories", story: "src/Button.stories.tsx#Primary" },
    };
    expect(roundTrip(stories)).toEqual(stories);
    const schemas: DeepLink = {
      ws: "abc",
      mode: "surfaces",
      surfaces: {
        view: "schemas",
        system: "sys:data",
        schema: "src/models/form.ts#FormSchema",
      },
    };
    expect(roundTrip(schemas)).toEqual(schemas);
  });

  it("architecture side pane travels on every surfaces subview", () => {
    for (const view of ["screens", "components", "stories", "apis", "schemas"] as const) {
      const link: DeepLink = {
        ws: "abc",
        mode: "surfaces",
        surfaces: { view, arch: true },
      };
      expect(roundTrip(link)).toEqual(link);
    }
    // off = omitted entirely
    expect(parseDeepLink("#/surfaces/apis").surfaces?.arch).toBeUndefined();
  });

  it("surfaces defaults to screens and scopes params per subview", () => {
    // The system map folded into the architecture view.
    expect(formatDeepLink({ mode: "surfaces" })).toBe("#/surfaces/screens");
    // Legacy map links redirect: sys/screen nodes land selected on the
    // architecture canvas with the screens layer on…
    expect(parseDeepLink("#/surfaces/map?node=screen%3Anext-app%3A%2Fbook&find=book")).toEqual({
      mode: "architect",
      architect: {
        view: "architecture",
        layers: "screens",
        sel: "node:screen:next-app:/book",
        find: "book",
      },
    });
    // …and endpoint selections land in the API explorer, which owns them.
    expect(parseDeepLink("#/surfaces/map?node=ep%3AGET%20%2Favailability")).toEqual({
      mode: "surfaces",
      surfaces: { view: "apis", api: "GET /availability" },
    });
    // A components URL cannot carry a screen selection.
    expect(
      formatDeepLink({
        mode: "surfaces",
        surfaces: { view: "components", screen: "next-app:/", component: "a.tsx#A" },
      }),
    ).toBe("#/surfaces/components?component=a.tsx%23A");
    // demo is a lens on screens/stories only.
    expect(formatDeepLink({ mode: "surfaces", surfaces: { view: "apis", demo: true } })).toBe(
      "#/surfaces/apis",
    );
  });

  it("quality subviews round-trip their selections", () => {
    const tests: DeepLink = {
      ws: "abc",
      mode: "quality",
      quality: {
        view: "tests",
        file: "packages/core/src/deeplink.test.ts",
        test: "round trips > code map levels",
        run: "q-3",
      },
    };
    expect(roundTrip(tests)).toEqual(tests);
    const coverage: DeepLink = {
      ws: "abc",
      mode: "quality",
      quality: { view: "coverage", covPath: "packages/core/src", find: "deeplink" },
    };
    expect(roundTrip(coverage)).toEqual(coverage);
  });

  it("quality defaults to the tests view and scopes params per subview", () => {
    expect(formatDeepLink({ mode: "quality" })).toBe("#/quality/tests");
    expect(
      formatDeepLink({
        mode: "quality",
        quality: { view: "coverage", file: "a.test.ts", covPath: "src" },
      }),
    ).toBe("#/quality/coverage?path=src");
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

  it("architecture panels and edge selection", () => {
    const link: DeepLink = {
      ws: "abc",
      mode: "architect",
      architect: {
        view: "architecture",
        edge: "sys:auth->sys:data",
        contracts: true,
      },
    };
    expect(roundTrip(link)).toEqual(link);
    expect(formatDeepLink(link)).toBe(
      "#/architect/architecture?ws=abc&edge=sys%3Aauth-%3Esys%3Adata&contracts=1",
    );
    const insights: DeepLink = {
      ws: "abc",
      mode: "architect",
      architect: { view: "architecture", insights: true, facets: true },
    };
    expect(roundTrip(insights)).toEqual(insights);
  });

  it("architecture focus filter with optional solo flag", () => {
    const link: DeepLink = {
      ws: "abc",
      mode: "architect",
      architect: {
        view: "architecture",
        focus: "sys:auth,sys:data",
        focusSolo: true,
      },
    };
    expect(roundTrip(link)).toEqual(link);
    expect(formatDeepLink(link)).toBe(
      "#/architect/architecture?ws=abc&focus=sys%3Aauth,sys%3Adata&solo=1",
    );
    // neighbors shown by default — solo omitted when off
    const neighbors: DeepLink = {
      ws: "abc",
      mode: "architect",
      architect: { view: "architecture", focus: "sys:auth" },
    };
    expect(roundTrip(neighbors)).toEqual(neighbors);
    expect(formatDeepLink(neighbors)).toBe("#/architect/architecture?ws=abc&focus=sys%3Aauth");
    // solo without a focus set is meaningless — not emitted, not parsed
    expect(
      formatDeepLink({
        ws: "abc",
        mode: "architect",
        architect: { view: "architecture", focusSolo: true },
      }),
    ).toBe("#/architect/architecture?ws=abc");
    expect(parseDeepLink("#/architect/architecture?solo=1").architect?.focusSolo).toBeUndefined();
  });

  it("code map facets panel and selected file card", () => {
    const link: DeepLink = {
      ws: "abc",
      mode: "architect",
      architect: {
        view: "codebase",
        codemap: { kind: "module", ws: "abc", path: "packages/core" },
        facets: true,
        file: "packages/core/src/bridge.ts",
      },
    };
    expect(roundTrip(link)).toEqual(link);
  });
});

describe("applyDeepLink", () => {
  it("replaces only the incoming subview's fields, keeping sibling-subview state", () => {
    const current: DeepLink = {
      mode: "architect",
      ws: "w1",
      architect: {
        view: "codebase",
        codemap: { kind: "module", ws: "w1", path: "packages/core" },
        lod: "modules",
        diagram: "a.crystal",
        system: "sys:auth",
      },
    };
    // Back onto an architecture URL: its owned fields are replaced (stale
    // `system` and legacy `diagram` cleared, `focus` applied); the drill
    // level and LoD — which it cannot express — survive.
    const next = applyDeepLink(current, {
      mode: "architect",
      architect: { view: "architecture", focus: "sys:auth" },
    });
    expect(next.architect).toEqual({
      view: "architecture",
      focus: "sys:auth",
      codemap: { kind: "module", ws: "w1", path: "packages/core" },
      lod: "modules",
    });
  });

  it("replaces the threads section wholesale", () => {
    const current: DeepLink = {
      mode: "threads",
      threads: { thread: "r1", find: "auth" },
    };
    const next = applyDeepLink(current, { mode: "threads", threads: { thread: "r2" } });
    expect(next.threads).toEqual({ thread: "r2" });
    const cleared = applyDeepLink(current, { mode: "threads" });
    expect(cleared.threads).toBeUndefined();
  });

  it("treats a bare architect URL as the default view with nothing selected", () => {
    const current: DeepLink = {
      mode: "architect",
      architect: { view: "architecture", system: "sys:auth", lod: "members" },
    };
    const next = applyDeepLink(current, { mode: "architect" });
    // architecture-owned fields clear; the code map's LoD survives.
    expect(next.architect).toEqual({ lod: "members" });
  });

  it("keeps sibling-subview state across surfaces and quality URLs", () => {
    const current: DeepLink = {
      mode: "surfaces",
      surfaces: { view: "apis", api: "GET /x", system: "sys:a", component: "b.tsx#B" },
    };
    // Back onto a components URL: apis-owned fields survive (a components URL
    // cannot express them); the component selection is replaced.
    const next = applyDeepLink(current, {
      mode: "surfaces",
      surfaces: { view: "components", component: "a.tsx#A" },
    });
    expect(next.surfaces).toEqual({
      view: "components",
      component: "a.tsx#A",
      api: "GET /x",
      system: "sys:a",
    });
    const qCurrent: DeepLink = {
      mode: "quality",
      quality: { view: "tests", file: "a.test.ts", covPath: "src" },
    };
    const qNext = applyDeepLink(qCurrent, { mode: "quality", quality: { view: "coverage" } });
    // coverage-owned covPath clears (bare coverage URL = nothing selected);
    // the tests-view file selection survives.
    expect(qNext.quality).toEqual({ view: "coverage", file: "a.test.ts" });
  });

  it("leaves other modes' sections untouched and lets ws/mode win", () => {
    const current: DeepLink = {
      mode: "architect",
      ws: "w1",
      architect: { diagram: "a.crystal" },
      threads: { thread: "r1" },
    };
    const next = applyDeepLink(current, { mode: "code", ws: "w2", code: { file: "x.ts" } });
    expect(next).toEqual({
      mode: "code",
      ws: "w2",
      code: { file: "x.ts" },
      architect: { diagram: "a.crystal" },
      threads: { thread: "r1" },
    });
  });
});

describe("applyDeepLink (overview)", () => {
  it("keeps the program selection out of the inbox and back on return", () => {
    const current: DeepLink = {
      mode: "projects",
      projects: { view: "threads", program: "prog_1", turn: "run_1" },
    };
    const onInbox = applyDeepLink(current, { mode: "projects", projects: { view: "inbox" } });
    // The inbox URL owns only view+find, so the program selection survives
    // untouched underneath it.
    expect(onInbox.projects).toEqual({ view: "inbox", program: "prog_1", turn: "run_1" });

    const back = applyDeepLink(onInbox, {
      mode: "projects",
      projects: { view: "threads", program: "prog_2" },
    });
    // …and a chat URL's program replaces the stored one.
    expect(back.projects).toEqual({ view: "threads", program: "prog_2" });
  });
});

describe("deepLinkNavIdentity", () => {
  const base: DeepLink = { mode: "architect", architect: { view: "architecture" } };

  it("ignores selections and panels", () => {
    expect(
      deepLinkNavIdentity({
        ...base,
        architect: { view: "architecture", system: "sys:auth", insights: true },
      }),
    ).toBe(deepLinkNavIdentity(base));
  });

  it("matches the render default when the view is unset", () => {
    expect(deepLinkNavIdentity({ mode: "architect" })).toBe(deepLinkNavIdentity(base));
  });

  it("changes when the subview, drill level or document changes", () => {
    expect(deepLinkNavIdentity({ mode: "architect", architect: { view: "codebase" } })).not.toBe(
      deepLinkNavIdentity(base),
    );
    const drillA: DeepLink = {
      mode: "architect",
      architect: { view: "codebase", codemap: { kind: "module", ws: "w", path: "a" } },
    };
    const drillB: DeepLink = {
      mode: "architect",
      architect: { view: "codebase", codemap: { kind: "module", ws: "w", path: "b" } },
    };
    expect(deepLinkNavIdentity(drillA)).not.toBe(deepLinkNavIdentity(drillB));
    expect(
      deepLinkNavIdentity({ mode: "architect", architect: { view: "infra", draft: "a" } }),
    ).not.toBe(
      deepLinkNavIdentity({ mode: "architect", architect: { view: "infra", draft: "b" } }),
    );
    expect(deepLinkNavIdentity({ mode: "code", code: { file: "a.ts" } })).not.toBe(
      deepLinkNavIdentity({ mode: "code", code: { file: "b.ts" } }),
    );
  });

  it("surfaces/quality: the subview is the place, selections are not", () => {
    const screens: DeepLink = { mode: "surfaces", surfaces: { view: "screens" } };
    expect(
      deepLinkNavIdentity({
        mode: "surfaces",
        surfaces: { view: "screens", screen: "next-app:/", demo: true },
      }),
    ).toBe(deepLinkNavIdentity(screens));
    // The bare mode is the screens list — the mode's default view.
    expect(deepLinkNavIdentity({ mode: "surfaces" })).toBe(
      deepLinkNavIdentity({ mode: "surfaces", surfaces: { view: "screens" } }),
    );
    expect(deepLinkNavIdentity({ mode: "surfaces", surfaces: { view: "apis" } })).not.toBe(
      deepLinkNavIdentity(screens),
    );
    const tests: DeepLink = { mode: "quality", quality: { view: "tests" } };
    expect(
      deepLinkNavIdentity({ mode: "quality", quality: { view: "tests", file: "a.test.ts" } }),
    ).toBe(deepLinkNavIdentity(tests));
    expect(deepLinkNavIdentity({ mode: "quality", quality: { view: "coverage" } })).not.toBe(
      deepLinkNavIdentity(tests),
    );
  });

  it("threads: each thread is a place; rail filter and composer are not", () => {
    const a: DeepLink = { mode: "threads", threads: { thread: "r1" } };
    expect(deepLinkNavIdentity({ mode: "threads", threads: { thread: "r1", find: "x" } })).toBe(
      deepLinkNavIdentity(a),
    );
    expect(deepLinkNavIdentity({ mode: "threads", threads: { thread: "r2" } })).not.toBe(
      deepLinkNavIdentity(a),
    );
    expect(deepLinkNavIdentity({ mode: "threads" })).not.toBe(deepLinkNavIdentity(a));
  });

  it("ignores a program selection the inbox does not own", () => {
    // The selection survives underneath the inbox (PROJECTS_VIEW_FIELDS),
    // but the URL there never carries it — reading it in the identity made
    // every keystroke in the find box push a history entry.
    const a: DeepLink = { mode: "projects", projects: { view: "inbox", program: "prog_1" } };
    const b: DeepLink = { mode: "projects", projects: { view: "inbox" } };
    expect(deepLinkNavIdentity(a)).toBe(deepLinkNavIdentity(b));
    expect(deepLinkNavIdentity(a)).toBe(deepLinkNavIdentity(parseDeepLink(formatDeepLink(a))));
  });

  it("treats opening an overview thread or program as its own place", () => {
    const dashboard: DeepLink = { mode: "projects" };
    const chat: DeepLink = { mode: "projects", projects: { view: "threads" } };
    const opened: DeepLink = { mode: "projects", projects: { view: "threads", program: "prog_1" } };
    const selectedTurn: DeepLink = {
      mode: "projects",
      projects: { view: "threads", program: "prog_1", turn: "run_2" },
    };
    expect(deepLinkNavIdentity(dashboard)).not.toBe(deepLinkNavIdentity(chat));
    expect(deepLinkNavIdentity(chat)).not.toBe(deepLinkNavIdentity(opened));
    expect(deepLinkNavIdentity(selectedTurn)).toBe(deepLinkNavIdentity(opened));
    expect(deepLinkNavIdentity({ mode: "projects", projects: { view: "threads", thread: "r1", program: "prog_1" } }))
      .toBe("projects/threads/r1");
  });
});

describe("mode aliases", () => {
  it("maps guessed names onto real modes (and implied subviews)", () => {
    expect(parseDeepLink("#/overview").mode).toBe("projects");
    expect(parseDeepLink("#/editor").mode).toBe("code");
    expect(parseDeepLink("#/architecture").mode).toBe("architect");
    const coverage = parseDeepLink("#/coverage");
    expect(coverage.mode).toBe("quality");
    expect(coverage.quality?.view).toBe("coverage");
    const apis = parseDeepLink("#/apis?api=GET%20/api/v1/keys");
    expect(apis.mode).toBe("surfaces");
    expect(apis.surfaces?.view).toBe("apis");
  });

  it("maps program vocabulary onto the overview's threads and inbox", () => {
    expect(parseDeepLink("#/programs").mode).toBe("projects");
    expect(parseDeepLink("#/programs").projects?.view).toBe("threads");
    expect(parseDeepLink("#/portfolio").projects?.view).toBe("threads");
    expect(parseDeepLink("#/inbox").projects?.view).toBe("inbox");
    expect(parseDeepLink("#/questions").projects?.view).toBe("inbox");
  });

  it("leaves genuinely unknown modes unparsed", () => {
    expect(parseDeepLink("#/definitely-not-a-mode").mode).toBeUndefined();
  });
});

describe("consolidated diagram views", () => {
  it("architecture round-trips systems-style and diagram-style state together", () => {
    const link: DeepLink = {
      ws: "abc",
      mode: "architect",
      architect: {
        view: "architecture",
        system: "sys:auth",
        edge: "sys:auth->sys:api",
        focus: "sys:auth",
        focusSolo: true,
        insights: true,
        contracts: true,
        facets: true,
        layers: "screens,endpoints",
        facet: "facet-1",
        draft: ".crystal/architecture/drafts/plan.crystal",
        review: true,
        journey: "j-1",
        overlay: true,
        sel: "n:auth",
        find: "queue",
        vs: "main",
      },
    };
    expect(roundTrip(link)).toEqual(link);
  });

  it("codebase round-trips the drill level, lod and vs-ref", () => {
    const link: DeepLink = {
      ws: "abc",
      mode: "architect",
      architect: {
        view: "codebase",
        codemap: { kind: "module", ws: "abc", path: "packages/core" },
        lod: "members",
        duplicates: true,
        file: "packages/core/src/bridge.ts",
        vs: "release/0.9",
      },
    };
    expect(roundTrip(link)).toEqual(link);
  });

  it("vs travels on every architect subview", () => {
    for (const view of ["architecture", "codebase", "infra"] as const) {
      const link: DeepLink = {
        ws: "abc",
        mode: "architect",
        architect: { view, vs: "feature/x" },
      };
      expect(roundTrip(link)).toEqual(link);
    }
  });

  it("systems is a permanent parse alias of architecture", () => {
    const parsed = parseDeepLink(
      "#/architect/systems?ws=abc&system=sys%3Aauth&insights=1&focus=sys%3Aauth",
    );
    expect(parsed.architect?.view).toBe("architecture");
    expect(parsed.architect?.system).toBe("sys:auth");
    expect(parsed.architect?.insights).toBe(true);
    expect(parsed.architect?.focus).toBe("sys:auth");
  });

  it("codemap is a permanent parse alias of codebase", () => {
    const parsed = parseDeepLink("#/architect/codemap?ws=abc&at=module&path=packages/ui&vs=main");
    expect(parsed.architect?.view).toBe("codebase");
    expect(parsed.architect?.codemap).toEqual({ kind: "module", ws: "abc", path: "packages/ui" });
    expect(parsed.architect?.vs).toBe("main");
  });

  it("back/forward onto an architecture URL replaces only its owned fields", () => {
    const current: DeepLink = {
      mode: "architect",
      architect: {
        view: "architecture",
        focus: "sys:auth",
        vs: "main",
        codemap: { kind: "module", ws: "abc", path: "packages/core" }, // codebase state survives
      },
    };
    const next = parseDeepLink("#/architect/architecture?ws=abc&facet=facet-2");
    const applied = applyDeepLink(current, next);
    expect(applied.architect?.facet).toBe("facet-2");
    expect(applied.architect?.focus).toBeUndefined(); // owned + absent → cleared
    expect(applied.architect?.vs).toBeUndefined();
    expect(applied.architect?.codemap).toEqual({ kind: "module", ws: "abc", path: "packages/core" });
  });

  it("nav identity: architecture is a place per facet/draft, codebase per drill level", () => {
    const at = (architect: DeepLink["architect"]) =>
      deepLinkNavIdentity({ mode: "architect", architect });
    expect(at({ view: "architecture", facet: "f1" })).not.toBe(
      at({ view: "architecture", facet: "f2" }),
    );
    expect(at({ view: "architecture", facet: "f1", sel: "a" })).toBe(
      at({ view: "architecture", facet: "f1", sel: "b" }),
    );
    expect(at({ view: "codebase", codemap: { kind: "module", ws: "w", path: "a" } })).not.toBe(
      at({ view: "codebase", codemap: { kind: "module", ws: "w", path: "b" } }),
    );
  });
});

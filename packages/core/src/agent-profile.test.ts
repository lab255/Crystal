import { describe, expect, it } from "vitest";
import {
  AUTO_MODEL,
  AgentProfileSchema,
  AgentRosterSchema,
  DEFAULT_PRESET_ID,
  applyProfileOverlay,
  createDefaultRoster,
  matchAgent,
  presetById,
  profileOverlay,
  resolveProfileModel,
  rosterText,
  type AgentRoster,
  type ProfileDispatchInit,
} from "./agent-profile.js";
import { agentTag, createAgentRun, extractDispatches, isAgentTag } from "./agent.js";
import { tagDimension, tagDimensions, tagOverlap, tagValue, tagsInDimension } from "./tags.js";

describe("dimensional tags", () => {
  it("splits dimension and value, leaving bare tags dimensionless", () => {
    expect(tagDimension("area:server")).toBe("area");
    expect(tagValue("area:server")).toBe("server");
    expect(tagDimension("ux")).toBeNull();
    expect(tagValue("ux")).toBe("ux");
    // A leading colon is not a dimension separator.
    expect(tagDimension(":odd")).toBeNull();
  });

  it("lists dimensions and per-dimension values", () => {
    const tags = ["area:server", "area:client", "phase:review", "ux"];
    expect(tagDimensions(tags)).toEqual(["area", "phase"]);
    expect(tagsInDimension(tags, "area")).toEqual(["server", "client"]);
    expect(tagsInDimension(tags, "missing")).toEqual([]);
  });

  it("computes overlap on exact tags", () => {
    expect(tagOverlap(["area:server", "ux"], ["ux", "area:client"])).toEqual(["ux"]);
  });
});

describe("matchAgent", () => {
  const roster: AgentRoster = {
    agents: [
      {
        id: "gen",
        name: "Generalist",
        kind: "generic",
        model: "opus",
        skills: [],
        tags: [],
        scope: "project",
      },
      {
        id: "srv",
        name: "Server specialist",
        kind: "specialist",
        model: "fable",
        skills: ["verify"],
        tags: ["area:server"],
        scope: "project",
      },
      {
        id: "srv2",
        name: "Server+infra specialist",
        kind: "specialist",
        model: "opus",
        skills: [],
        tags: ["area:server", "kind:infra"],
        scope: "library",
      },
    ],
    defaultAgentId: "gen",
    defaultHuman: "eliot",
  };

  it("dispatches tagged work to the specialist with the largest overlap", () => {
    expect(matchAgent(["area:server"], roster)?.id).toBe("srv");
    expect(matchAgent(["area:server", "kind:infra"], roster)?.id).toBe("srv2");
  });

  it("falls back to the default generic agent when no specialist matches", () => {
    expect(matchAgent([], roster)?.id).toBe("gen");
    expect(matchAgent(["area:web"], roster)?.id).toBe("gen");
  });

  it("seeds a roster whose default resolves and whose ids are stable", () => {
    const a = createDefaultRoster();
    const b = createDefaultRoster();
    expect(a.agents.map((x) => x.id)).toEqual(b.agents.map((x) => x.id));
    expect(matchAgent([], a)?.kind).toBe("generic");
  });
});

describe("profile schema", () => {
  it("parses pre-policy records (old agents.json files must keep loading)", () => {
    const roster = AgentRosterSchema.parse({
      agents: [{ id: "a", name: "A", kind: "generic", model: "opus", skills: [], tags: [] }],
      defaultAgentId: "a",
      defaultHuman: "",
    });
    const agent = roster.agents[0]!;
    expect(agent.scope).toBe("project");
    expect(agent.appendPrompt).toBeUndefined();
    expect(agent.permissionMode).toBeUndefined();
    expect(roster.managerAgentId).toBeUndefined();
  });

  it("round-trips the new policy fields", () => {
    const profile = AgentProfileSchema.parse({
      id: "sec",
      name: "Security reviewer",
      kind: "specialist",
      appendPrompt: "Only review; never edit files.",
      allowedTools: ["Bash(semgrep *)"],
      disallowedTools: ["Write", "Edit"],
      permissionMode: "plan",
      defaults: { purpose: "security-review", isolation: "none" },
      scope: "library",
    });
    expect(profile.permissionMode).toBe("plan");
    expect(profile.defaults?.purpose).toBe("security-review");
    expect(profile.scope).toBe("library");
  });
});

describe("agent tag", () => {
  it("mints and recognizes the attribution tag", () => {
    expect(agentTag("agent_x")).toBe("agent:agent_x");
    expect(isAgentTag("agent:agent_x")).toBe(true);
    expect(isAgentTag("workflow:wf_1")).toBe(false);
  });

  it("is stamped onto every run created for a profile", () => {
    const run = createAgentRun({ prompt: "go", agentId: "agent_x", tags: ["workflow:wf_1"] });
    expect(run.tags).toContain("agent:agent_x");
    expect(run.tags).toContain("workflow:wf_1");
    // Idempotent — a caller passing the tag explicitly must not double it.
    const again = createAgentRun({ prompt: "go", agentId: "agent_x", tags: ["agent:agent_x"] });
    expect(again.tags).toEqual(["agent:agent_x"]);
  });
});

describe("profileOverlay / applyProfileOverlay", () => {
  const profile = AgentProfileSchema.parse({
    id: "sec",
    name: "Security reviewer",
    kind: "specialist",
    model: "sonnet",
    skills: ["security-review"],
    appendPrompt: "Only review; never edit files.\nSecond line.",
    allowedTools: ["Bash(semgrep *)", "Bash(git log*)"],
    disallowedTools: ["Write"],
    permissionMode: "plan",
    defaults: { purpose: "security-review", isolation: "worktree" },
  });

  it("flattens a profile into the dispatch overlay, agent tag included", () => {
    const overlay = profileOverlay(profile);
    expect(overlay).toMatchObject({
      agentId: "sec",
      model: "sonnet",
      appendPrompt: "Only review; never edit files.\nSecond line.",
      permissionMode: "plan",
      extraTags: ["agent:sec"],
    });
  });

  it("lets explicit dispatch values win, merges tool lists, fills defaults", () => {
    const overlay = profileOverlay(profile);
    const merged = applyProfileOverlay<ProfileDispatchInit>(
      {
        model: "opus", // explicit — beats the profile's sonnet
        allowedTools: ["Bash(git log*)"],
        tags: ["workflow:wf_1"],
      },
      overlay,
    );
    expect(merged.model).toBe("opus");
    expect(merged.skills).toEqual(["security-review"]);
    expect(merged.allowedTools).toEqual(["Bash(git log*)", "Bash(semgrep *)"]);
    expect(merged.disallowedTools).toEqual(["Write"]);
    expect(merged.permissionMode).toBe("plan");
    expect(merged.purpose).toBe("security-review");
    expect(merged.isolation).toBe("worktree");
    expect(merged.tags).toEqual(["workflow:wf_1", "agent:sec"]);
    // Null overlay = untouched params (no phantom keys clobbering callers).
    expect(applyProfileOverlay({ model: null }, null)).toEqual({ model: null });
  });
});

describe("rosterText", () => {
  it("renders each profile on one line with a one-line standing hint", () => {
    const roster = AgentRosterSchema.parse({
      agents: [
        { id: "gen", name: "Generalist", kind: "generic", model: "opus" },
        {
          id: "sec",
          name: "Security reviewer",
          kind: "specialist",
          model: "sonnet",
          tags: ["area:security"],
          skills: ["security-review"],
          appendPrompt: "Only review; never edit files.\nSecond line never shows.",
        },
      ],
    });
    const text = rosterText(roster.agents);
    expect(text).toContain('- gen "Generalist" · generic · model opus');
    expect(text).toContain('- sec "Security reviewer" · specialist · model sonnet');
    expect(text).toContain("tags: area:security");
    expect(text).toContain("standing: Only review; never edit files.");
    expect(text).not.toContain("Second line never shows");
    expect(rosterText([])).toBe("");
  });
});

describe("model presets", () => {
  it("resolves 'auto' models by preset and kind, pins always win", () => {
    const generic = AgentProfileSchema.parse({ id: "g", name: "G", kind: "generic" });
    const specialist = AgentProfileSchema.parse({ id: "s", name: "S", kind: "specialist" });
    const pinned = AgentProfileSchema.parse({ id: "p", name: "P", kind: "specialist", model: "haiku" });

    expect(generic.model).toBe(AUTO_MODEL);
    expect(resolveProfileModel(generic, presetById("balanced"))).toBe("sonnet");
    expect(resolveProfileModel(specialist, presetById("balanced"))).toBe("opus");
    expect(resolveProfileModel(generic, presetById("frontier"))).toBe("opus");
    expect(resolveProfileModel(specialist, presetById("frontier"))).toBe("fable");
    expect(resolveProfileModel(pinned, presetById("frontier"))).toBe("haiku");
  });

  it("gives managers the preset's manager model whatever profile they run as", () => {
    const generic = AgentProfileSchema.parse({ id: "g", name: "G", kind: "generic" });
    expect(resolveProfileModel(generic, presetById("balanced"), "manager")).toBe("opus");
    expect(resolveProfileModel(generic, presetById("frontier"), "manager")).toBe("fable");
    expect(profileOverlay(generic, presetById("frontier"), "manager").model).toBe("fable");
  });

  it("falls back to the default preset on unknown ids and renders resolved models", () => {
    expect(presetById("no-such-preset").id).toBe(DEFAULT_PRESET_ID);
    expect(presetById(null).id).toBe(DEFAULT_PRESET_ID);
    // An overlay never leaks the "auto" sentinel to a spawn.
    const roster = createDefaultRoster();
    for (const p of roster.agents) {
      expect(profileOverlay(p, presetById(roster.preset)).model).not.toBe(AUTO_MODEL);
    }
    expect(rosterText(roster.agents, presetById("frontier"))).toContain("model fable");
    expect(rosterText(roster.agents, presetById("frontier"))).not.toContain("model auto");
  });
});

describe("WorkerSpec.agentId", () => {
  it("rides the CRYSTAL_DISPATCH marker", () => {
    const specs = extractDispatches(
      'CRYSTAL_DISPATCH: {"prompt":"Audit the auth flow.","agentId":"sec","taskId":"task_9"}',
    );
    expect(specs).toHaveLength(1);
    expect(specs[0]!.agentId).toBe("sec");
  });
});

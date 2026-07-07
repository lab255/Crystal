import { describe, expect, it } from "vitest";
import { createDefaultRoster, matchAgent, type AgentRoster } from "./agent-profile.js";
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
      { id: "gen", name: "Generalist", kind: "generic", model: "opus", skills: [], tags: [] },
      {
        id: "srv",
        name: "Server specialist",
        kind: "specialist",
        model: "fable",
        skills: ["verify"],
        tags: ["area:server"],
      },
      {
        id: "srv2",
        name: "Server+infra specialist",
        kind: "specialist",
        model: "opus",
        skills: [],
        tags: ["area:server", "kind:infra"],
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

import { z } from "zod";
import { uid } from "./ids.js";
import { tagOverlap } from "./tags.js";

/**
 * Agent roster — `.crystal/agents.json`.
 *
 * The named agent profiles work is dispatched to. A *generic* agent is the
 * fallback for untagged work; a *specialist* owns context tags (and optional
 * skills) and wins dispatch for tasks whose tags overlap its own. Models are
 * configurable per profile (e.g. a sonnet/opus generalist, an opus-with-skills
 * or fable specialist) and are passed to the CLI as `--model` at spawn time.
 */

export const AGENT_PROFILE_KINDS = ["generic", "specialist"] as const;
export const AgentProfileKindSchema = z.enum(AGENT_PROFILE_KINDS);
export type AgentProfileKind = z.infer<typeof AgentProfileKindSchema>;

export const AgentProfileSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: AgentProfileKindSchema.default("generic"),
  /** Claude model alias or id (`--model`), e.g. "sonnet", "opus", "fable". */
  model: z.string().default("sonnet"),
  /** Skill names woven into dispatch prompts (specialists). */
  skills: z.array(z.string()).default([]),
  /** Context tags this specialist owns (see tags.ts). */
  tags: z.array(z.string()).default([]),
});
export type AgentProfile = z.infer<typeof AgentProfileSchema>;

export const AgentRosterSchema = z.object({
  agents: z.array(AgentProfileSchema).default([]),
  /** Generic agent used when no specialist matches (defaults to the first generic). */
  defaultAgentId: z.string().nullish(),
  /** Human owner stamped onto new tasks by default. */
  defaultHuman: z.string().default(""),
});
export type AgentRoster = z.infer<typeof AgentRosterSchema>;

export function createAgentProfile(
  name: string,
  kind: AgentProfileKind,
  model: string,
): AgentProfile {
  return AgentProfileSchema.parse({ id: uid("agent"), name, kind, model });
}

/**
 * The seeded roster for workspaces without `.crystal/agents.json`. Ids are
 * fixed (not uid()-minted) so tasks assigned before the file is first saved
 * still resolve after it is.
 */
export function createDefaultRoster(): AgentRoster {
  return AgentRosterSchema.parse({
    agents: [
      { id: "agent_generalist", name: "Generalist", kind: "generic", model: "opus" },
      { id: "agent_specialist", name: "Specialist", kind: "specialist", model: "fable" },
    ],
    defaultAgentId: "agent_generalist",
    defaultHuman: "",
  });
}

/**
 * Pick the dispatch agent for a tag set: the specialist with the largest tag
 * overlap wins; otherwise the roster's default (or first) generic agent.
 */
export function matchAgent(tags: string[], roster: AgentRoster): AgentProfile | null {
  let best: AgentProfile | null = null;
  let bestOverlap = 0;
  for (const agent of roster.agents) {
    if (agent.kind !== "specialist") continue;
    const overlap = tagOverlap(tags, agent.tags).length;
    if (overlap > bestOverlap) {
      best = agent;
      bestOverlap = overlap;
    }
  }
  if (best) return best;
  return (
    roster.agents.find((a) => a.id === roster.defaultAgentId) ??
    roster.agents.find((a) => a.kind === "generic") ??
    roster.agents[0] ??
    null
  );
}

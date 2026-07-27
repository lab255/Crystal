import { z } from "zod";
import { uid } from "./ids.js";
import { tagOverlap } from "./tags.js";
import {
  AgentIsolationSchema,
  RunPurposeSchema,
  agentTag,
  type AgentIsolation,
  type RunPurpose,
} from "./agent.js";

/**
 * Agent roster — `.crystal/agents.json` plus the shared `~/.crystal/agents`
 * library.
 *
 * The named agent profiles work is dispatched to. A *generic* agent is the
 * fallback for untagged work; a *specialist* owns context tags (and optional
 * skills) and wins dispatch for tasks whose tags overlap its own. Models are
 * configurable per profile (e.g. a sonnet/opus generalist, an opus-with-skills
 * or fable specialist) and are passed to the CLI as `--model` at spawn time.
 *
 * Beyond identity, a profile carries *standing behavior*: `appendPrompt`
 * (durable instructions passed as `--append-system-prompt`, so they survive
 * `--resume` turns), a tool policy (`allowedTools` merged over the dev-loop
 * allowlist, `disallowedTools`, `permissionMode`), and dispatch `defaults`.
 * A profile is *who*, never *where* or *how much* — cwd, branch and budget
 * stay per-dispatch / workflow-owned.
 */

export const AGENT_PROFILE_KINDS = ["generic", "specialist"] as const;
export const AgentProfileKindSchema = z.enum(AGENT_PROFILE_KINDS);
export type AgentProfileKind = z.infer<typeof AgentProfileKindSchema>;

/**
 * `--permission-mode` for the profile's runs. Unset keeps today's behavior
 * (acceptEdits — headless runs have nobody to answer prompts).
 */
export const AGENT_PERMISSION_MODES = ["default", "acceptEdits", "plan"] as const;
export const AgentPermissionModeSchema = z.enum(AGENT_PERMISSION_MODES);
export type AgentPermissionMode = z.infer<typeof AgentPermissionModeSchema>;

/**
 * Where a profile lives, which is also who sees it:
 *
 * - `project` — inside `.crystal/agents.json`, repo-versioned; a team's agents
 *   travel with the repo.
 * - `library` — `~/.crystal/agents/<id>.json`, shared by every project on
 *   this machine (and what the hub resolves against).
 *
 * Like workflow templates, the *directory decides* on read — the persisted
 * field is display data, re-stamped by whichever store loaded the record.
 */
export const AGENT_PROFILE_SCOPES = ["project", "library"] as const;
export const AgentProfileScopeSchema = z.enum(AGENT_PROFILE_SCOPES);
export type AgentProfileScope = z.infer<typeof AgentProfileScopeSchema>;

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
  /** Standing instructions, passed as `--append-system-prompt` on every run. */
  appendPrompt: z.string().optional(),
  /** Extra pre-allowed tools, merged (deduped) over the dev-loop allowlist. */
  allowedTools: z.array(z.string()).optional(),
  /** Tools this profile may never use (`--disallowedTools`). */
  disallowedTools: z.array(z.string()).optional(),
  /** Overrides the hardcoded acceptEdits when set. */
  permissionMode: AgentPermissionModeSchema.optional(),
  /** Dispatch defaults applied when the dispatch itself doesn't say. */
  defaults: z
    .object({
      purpose: RunPurposeSchema.optional(),
      isolation: AgentIsolationSchema.optional(),
    })
    .optional(),
  /** Storage scope; the loading directory re-stamps this on read. */
  scope: AgentProfileScopeSchema.default("project"),
});
export type AgentProfile = z.infer<typeof AgentProfileSchema>;

export const AgentRosterSchema = z.object({
  agents: z.array(AgentProfileSchema).default([]),
  /** Generic agent used when no specialist matches (defaults to the first generic). */
  defaultAgentId: z.string().nullish(),
  /** Profile workflow/program managers run as (falls back to defaultAgentId). */
  managerAgentId: z.string().nullish(),
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

/* ------------------------------------------------------------------ */
/* Resolution overlay                                                  */
/* ------------------------------------------------------------------ */

/**
 * What resolving an agentId contributes to a dispatch — the one shape every
 * resolution path (agent.start, interactive, workers, workflow/hub managers,
 * index enrichment) applies, instead of each re-reading the roster. The
 * `agent:<id>` tag in `extraTags` is the attribution payoff: spend per
 * profile falls out of the existing tag index with zero new metering.
 */
export interface AgentProfileOverlay {
  agentId: string;
  model: string;
  skills: string[];
  appendPrompt: string | null;
  allowedTools: string[];
  disallowedTools: string[];
  permissionMode: AgentPermissionMode | null;
  defaults: { purpose?: RunPurpose; isolation?: AgentIsolation };
  extraTags: string[];
}

/** Flatten a profile into the overlay a dispatch applies. */
export function profileOverlay(profile: AgentProfile): AgentProfileOverlay {
  return {
    agentId: profile.id,
    model: profile.model,
    skills: profile.skills,
    appendPrompt: profile.appendPrompt?.trim() || null,
    allowedTools: profile.allowedTools ?? [],
    disallowedTools: profile.disallowedTools ?? [],
    permissionMode: profile.permissionMode ?? null,
    defaults: profile.defaults ?? {},
    extraTags: [agentTag(profile.id)],
  };
}

/** The dispatch fields an overlay can contribute to (explicit values win). */
export interface ProfileDispatchInit {
  model?: string | null;
  skills?: string[];
  appendSystemPrompt?: string | null;
  allowedTools?: string[];
  disallowedTools?: string[];
  permissionMode?: AgentPermissionMode | null;
  purpose?: RunPurpose | null;
  isolation?: AgentIsolation;
  tags?: string[];
}

/**
 * Merge an overlay under explicit dispatch params. Explicit values always
 * win (a WorkerSpec naming both agentId and model gets the spec's model);
 * tool lists merge (deduped) rather than replace — a profile can widen the
 * allowlist but never silently drop what the dispatch asked for.
 */
export function applyProfileOverlay<T extends ProfileDispatchInit>(
  params: T,
  overlay: AgentProfileOverlay | null | undefined,
): T {
  if (!overlay) return params;
  const merged: ProfileDispatchInit = {
    ...params,
    model: params.model ?? overlay.model,
    skills: params.skills?.length ? params.skills : overlay.skills,
    appendSystemPrompt: params.appendSystemPrompt ?? overlay.appendPrompt,
    allowedTools: [...new Set([...(params.allowedTools ?? []), ...overlay.allowedTools])],
    disallowedTools: [...new Set([...(params.disallowedTools ?? []), ...overlay.disallowedTools])],
    permissionMode: params.permissionMode ?? overlay.permissionMode,
    purpose: params.purpose ?? overlay.defaults.purpose ?? null,
    isolation: params.isolation ?? overlay.defaults.isolation,
    tags: [...new Set([...(params.tags ?? []), ...overlay.extraTags])],
  };
  // The widened fields above are exactly ProfileDispatchInit's — the cast
  // restores the caller's extra (untouched) properties.
  return merged as T;
}

/* ------------------------------------------------------------------ */
/* Agent-facing rendering                                              */
/* ------------------------------------------------------------------ */

/** How much of a profile's standing prompt the roster rendering shows. */
const ROSTER_STANDING_CHARS = 100;

/**
 * The roster as a manager reads it — one line per profile plus a one-line
 * standing-prompt hint. Rendered into the workflow/program manager prompts so
 * assigning an agent is a lookup by id, not a judgement call about models
 * (same principle as {@link boardMappingText} for board columns).
 */
export function rosterText(profiles: readonly AgentProfile[]): string {
  const lines: string[] = [];
  for (const p of profiles) {
    const bits = [
      `- ${p.id} "${p.name}"`,
      p.kind,
      `model ${p.model}`,
      p.tags.length ? `tags: ${p.tags.join(", ")}` : null,
      p.skills.length ? `skills: ${p.skills.join(", ")}` : null,
    ].filter(Boolean);
    lines.push(bits.join(" · "));
    const standing = p.appendPrompt?.trim().split("\n")[0];
    if (standing) {
      lines.push(
        `    standing: ${standing.length > ROSTER_STANDING_CHARS ? `${standing.slice(0, ROSTER_STANDING_CHARS)}…` : standing}`,
      );
    }
  }
  return lines.join("\n");
}

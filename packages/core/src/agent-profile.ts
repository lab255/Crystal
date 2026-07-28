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

/* ------------------------------------------------------------------ */
/* Model presets                                                       */
/* ------------------------------------------------------------------ */

/**
 * A model preset is the project's one cost/capability dial: which model the
 * top-level orchestrators run, and which models `"auto"` profiles resolve to
 * by kind. It rides the existing profile/tag/dispatch machinery — a preset
 * never bypasses profiles, it just answers "auto" — so per-profile pins and
 * per-dispatch `model` overrides keep winning exactly as before.
 */
export interface ModelPreset {
  id: string;
  name: string;
  description: string;
  /** Top-level orchestrators: workflow, program and board managers. */
  manager: string;
  /** Generic (`kind: "generic"`) profiles left on `"auto"`. */
  worker: string;
  /** Specialist profiles left on `"auto"`. */
  specialist: string;
}

export const MODEL_PRESETS: readonly ModelPreset[] = [
  {
    id: "balanced",
    name: "Balanced",
    description: "Opus orchestrators · Sonnet generalists · Opus specialists",
    manager: "opus",
    worker: "sonnet",
    specialist: "opus",
  },
  {
    id: "frontier",
    name: "Frontier",
    description: "Fable orchestrators · Opus generalists · Fable specialists",
    manager: "fable",
    worker: "opus",
    specialist: "fable",
  },
];

export const DEFAULT_PRESET_ID = "balanced";

/** Preset by id, falling back to the default — an unknown id never crashes a spawn. */
export function presetById(id?: string | null): ModelPreset {
  return (
    MODEL_PRESETS.find((p) => p.id === id) ??
    MODEL_PRESETS.find((p) => p.id === DEFAULT_PRESET_ID)!
  );
}

/** Sentinel model meaning "follow the roster's preset for my kind". */
export const AUTO_MODEL = "auto";

/**
 * Model aliases offered wherever a model is picked or hinted (profile editor,
 * dispatch override, template stages, workflow manager). Free text stays
 * allowed everywhere — any alias/id the CLI accepts — this is the one shared
 * suggestion list, so pickers can't drift out of sync.
 */
export const MODEL_HINTS = [AUTO_MODEL, "fable", "opus", "sonnet", "haiku"] as const;

/**
 * A profile's concrete `--model` value: its own pin always wins; "auto"
 * resolves by the run's place in the hierarchy — a manager gets the preset's
 * manager model whatever profile it runs as (orchestration is a role, not a
 * kind), everything else resolves by profile kind.
 */
export function resolveProfileModel(
  profile: AgentProfile,
  preset: ModelPreset,
  role?: "manager" | null,
): string {
  if (profile.model && profile.model !== AUTO_MODEL) return profile.model;
  if (role === "manager") return preset.manager;
  return profile.kind === "specialist" ? preset.specialist : preset.worker;
}

/**
 * `--permission-mode` for the profile's runs. Unset keeps today's behavior
 * (acceptEdits — headless runs have nobody to answer prompts).
 * `bypassPermissions` (the CLI's dangerously-skip-permissions mode) is only
 * honored when the workspace roster opts in via `allowBypassPermissions` —
 * the server downgrades it to acceptEdits otherwise, so a profile copied into
 * a workspace that never consented cannot skip its permission prompts.
 */
export const AGENT_PERMISSION_MODES = [
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
] as const;
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
  /**
   * Claude model alias or id (`--model`), e.g. "sonnet", "opus", "fable" —
   * or "auto" to follow the roster's model preset for this profile's kind.
   */
  model: z.string().default(AUTO_MODEL),
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
  /** Model preset id (see MODEL_PRESETS); null/unknown means the default. */
  preset: z.string().nullish(),
  /**
   * Workspace consent for `permissionMode: "bypassPermissions"` runs
   * (`--dangerously-skip-permissions`). Off by default; without it the server
   * downgrades bypass requests to acceptEdits. Workspace policy, not profile
   * data — a library profile must not smuggle bypass into every project.
   */
  allowBypassPermissions: z.boolean().default(false),
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
      // "auto" models: the roster's preset decides (Balanced out of the box —
      // Sonnet generalist, Opus specialist; Frontier lifts both a tier).
      { id: "agent_generalist", name: "Generalist", kind: "generic", model: AUTO_MODEL },
      { id: "agent_specialist", name: "Specialist", kind: "specialist", model: AUTO_MODEL },
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

/**
 * Flatten a profile into the overlay a dispatch applies. The preset resolves
 * "auto" models here, at the single choke point, so every consumer of an
 * overlay only ever sees a concrete model.
 */
export function profileOverlay(
  profile: AgentProfile,
  preset?: ModelPreset,
  role?: "manager" | null,
): AgentProfileOverlay {
  return {
    agentId: profile.id,
    model: resolveProfileModel(profile, preset ?? presetById(null), role),
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
export function rosterText(profiles: readonly AgentProfile[], preset?: ModelPreset): string {
  const lines: string[] = [];
  for (const p of profiles) {
    const bits = [
      `- ${p.id} "${p.name}"`,
      p.kind,
      `model ${resolveProfileModel(p, preset ?? presetById(null))}`,
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

import { z } from "zod";
import { uid } from "./ids.js";
import { tagOverlap } from "./tags.js";
import {
  AgentIsolationSchema,
  AgentProviderSchema,
  RunPurposeSchema,
  agentTag,
  type AgentIsolation,
  type AgentProvider,
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
 * A model preset is the project's one cost/capability dial: which model and
 * CLI provider the top-level orchestrators use, and which model/provider
 * `"auto"` profiles resolve to by kind and purpose. It rides the existing
 * profile/tag/dispatch machinery — a preset never bypasses profiles, it just
 * answers "auto" — so per-profile pins and per-dispatch `model` overrides
 * keep winning exactly as before.
 */
export interface ModelPreset {
  id: string;
  name: string;
  description: string;
  /** Top-level orchestrators: workflow, program and board managers. */
  manager: string;
  /** CLI vendor for managers; absent follows the profile provider. */
  managerProvider?: AgentProvider;
  /** Generic (`kind: "generic"`) profiles left on `"auto"`. */
  worker: string;
  /** CLI vendor for generic workers; absent follows the profile provider. */
  workerProvider?: AgentProvider;
  /** Specialist profiles left on `"auto"`. */
  specialist: string;
  /** CLI vendor for specialists; absent follows the profile provider. */
  specialistProvider?: AgentProvider;
  /** Merge/rebase/conflict runs; absent preserves the preset's worker behavior. */
  merge?: string;
  /** CLI vendor for merge runs; absent follows the profile provider. */
  mergeProvider?: AgentProvider;
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
  {
    id: "delegated",
    name: "Delegated",
    description: "Fable orchestrators · gpt-5.6-sol coding · Sonnet merge/rebase",
    manager: "fable",
    managerProvider: "claude",
    worker: "gpt-5.6-sol",
    workerProvider: "codex",
    specialist: "gpt-5.6-sol",
    specialistProvider: "codex",
    merge: "sonnet",
    mergeProvider: "claude",
  },
];

export const DEFAULT_PRESET_ID = "delegated";

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
 * Codex counterpart of {@link MODEL_HINTS}. "auto" resolves to
 * {@link DEFAULT_CODEX_MODEL} when the selected preset role does not name a
 * Codex model/provider explicitly.
 */
export const CODEX_MODEL_HINTS = [
  AUTO_MODEL,
  "gpt-5.6-sol",
  "gpt-5.2-codex",
  "gpt-5.2",
] as const;

/** What a codex profile's "auto" resolves to for a Claude-tier preset role. */
export const DEFAULT_CODEX_MODEL = "gpt-5.2-codex";

/** The suggestion list for a provider's model picker. */
export function modelHintsFor(provider: AgentProvider | null | undefined): readonly string[] {
  return provider === "codex" ? CODEX_MODEL_HINTS : MODEL_HINTS;
}

export type ModelPresetRole = "manager" | "worker" | "specialist" | "merge";

export interface ProfileResolutionInput {
  role?: "manager" | null;
  purpose?: RunPurpose | null;
}

export interface ResolvedProfileModel {
  model: string;
  provider: AgentProvider;
}

interface PresetRoleModel {
  model: string;
  provider?: AgentProvider;
}

function presetRoleModel(preset: ModelPreset, role: ModelPresetRole): PresetRoleModel {
  if (role === "manager") {
    return { model: preset.manager, provider: preset.managerProvider };
  }
  if (role === "specialist") {
    return { model: preset.specialist, provider: preset.specialistProvider };
  }
  if (role === "merge" && preset.merge) {
    return { model: preset.merge, provider: preset.mergeProvider };
  }
  return { model: preset.worker, provider: preset.workerProvider };
}

/** Resolve one preset role without a profile (server-side fallback spawns). */
export function resolvePresetModel(
  preset: ModelPreset,
  role: ModelPresetRole,
): ResolvedProfileModel {
  const selected = presetRoleModel(preset, role);
  return { model: selected.model, provider: selected.provider ?? "claude" };
}

function presetRoleFor(
  profile: AgentProfile,
  input?: ProfileResolutionInput | null,
): ModelPresetRole {
  if (input?.role === "manager") return "manager";
  if ((input?.purpose ?? profile.defaults?.purpose) === "merge") return "merge";
  return profile.kind === "specialist" ? "specialist" : "worker";
}

function resolveProfileModelAndProvider(
  profile: AgentProfile,
  preset: ModelPreset,
  input?: ProfileResolutionInput | null,
): ResolvedProfileModel {
  const profileProvider = profile.provider ?? "claude";
  if (profile.model && profile.model !== AUTO_MODEL) {
    return { model: profile.model, provider: profileProvider };
  }
  const selected = presetRoleModel(preset, presetRoleFor(profile, input));
  if (selected.provider) {
    return { model: selected.model, provider: selected.provider };
  }
  // A role without an explicit provider is a Claude tier. An explicitly
  // Codex profile still stays on Codex and uses its safe default instead of
  // sending a Claude alias to the OpenAI CLI.
  if (profileProvider === "codex") {
    return { model: DEFAULT_CODEX_MODEL, provider: "codex" };
  }
  return { model: selected.model, provider: "claude" };
}

/**
 * A profile's concrete `--model` value: its own pin always wins; "auto"
 * resolves by the run's place in the hierarchy and purpose. Provider-aware
 * callers should use {@link profileOverlay}, which resolves the model/vendor
 * pair atomically.
 */
export function resolveProfileModel(
  profile: AgentProfile,
  preset: ModelPreset,
  input?: ProfileResolutionInput | null,
): string {
  return resolveProfileModelAndProvider(profile, preset, input).model;
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
   * CLI vendor this profile's runs execute on. Defaults to "claude" so every
   * existing profile keeps its meaning; "codex" spawns the OpenAI Codex CLI.
   */
  provider: AgentProviderSchema.default("claude"),
  /**
   * Model alias or id (`--model`), e.g. "sonnet", "opus", "fable" (claude) or
   * "gpt-5.6-sol" / "gpt-5.2-codex" (codex) — or "auto" to follow the
   * roster's model preset for this profile's kind and run purpose (a preset
   * role may also switch the CLI vendor; otherwise codex profiles resolve
   * "auto" to the codex default rather than receiving a Claude-tier alias).
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
      // "auto" models: the roster's preset decides (Delegated out of the box —
      // Fable orchestration and Codex coding; the older presets remain selectable).
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
  provider: AgentProvider;
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
 * "auto" model/provider pairs here, at the single choke point, so every
 * consumer of an overlay only ever sees a concrete, CLI-compatible pair.
 */
export function profileOverlay(
  profile: AgentProfile,
  preset?: ModelPreset,
  input?: ProfileResolutionInput | null,
): AgentProfileOverlay {
  const resolved = resolveProfileModelAndProvider(profile, preset ?? presetById(null), input);
  return {
    agentId: profile.id,
    provider: resolved.provider,
    model: resolved.model,
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
  provider?: AgentProvider | null;
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
    provider: params.provider ?? overlay.provider,
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
    const resolved = resolveProfileModelAndProvider(p, preset ?? presetById(null));
    const bits = [
      `- ${p.id} "${p.name}"`,
      p.kind,
      // Claude is the unmarked case; a second vendor is worth a manager's
      // attention (no MCP board tools, own sandbox model).
      resolved.provider === "codex" ? "codex" : null,
      `model ${resolved.model}`,
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

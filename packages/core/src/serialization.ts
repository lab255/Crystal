import { z } from "zod";
import { AgentRosterSchema, type AgentRoster } from "./agent-profile.js";
import { ArchDraftSchema, type ArchDraft } from "./arch-draft.js";
import { ArchOverlaySchema, type ArchOverlay } from "./arch-overlay.js";
import { ArchitectureGraphSchema, type ArchitectureGraph } from "./architecture.js";
import {
  CodeEnrichmentSchema,
  migrateEnrichmentData,
  type CodeEnrichment,
} from "./code-index.js";
import { ProjectSchema, type Project } from "./project.js";
import { ServicesFileSchema, type ServicesFile } from "./service.js";
import { StandingTasksFileSchema, type StandingTasksFile } from "./standing-task.js";
import { ArchSurveySchema, migrateSurveyData, type ArchSurvey } from "./survey.js";
import { SystemsLayoutSchema, type SystemsLayout } from "./systems-layout.js";
import { TodoListSchema, type TodoList } from "./todo.js";
import {
  TraceProfileSchema,
  migrateTraceProfileData,
  type TraceProfile,
} from "./trace-profile.js";
import { WorkspaceManifestSchema, type WorkspaceManifest } from "./workspace.js";

/**
 * Versioned file envelope for everything Crystal writes into a repo.
 *
 * ```json
 * { "crystal": 1, "kind": "architecture", "data": { ... } }
 * ```
 *
 * The envelope keeps `.crystal/` files self-describing and lets future
 * versions migrate on read.
 */

export const CRYSTAL_FILE_VERSION = 1;

export type CrystalFileKind =
  | "architecture"
  | "archdraft"
  | "arch-overlay"
  | "project"
  | "workspace"
  | "survey"
  | "trace"
  | "todos"
  | "agents"
  | "enrichment"
  | "syslayout"
  | "services"
  | "standing";

const EnvelopeSchema = z.object({
  crystal: z.number(),
  kind: z.enum([
    "architecture",
    "archdraft",
    "arch-overlay",
    "project",
    "workspace",
    "survey",
    "trace",
    "todos",
    "agents",
    "enrichment",
    "syslayout",
    "services",
    "standing",
  ]),
  data: z.unknown(),
});

const DATA_SCHEMAS = {
  architecture: ArchitectureGraphSchema,
  archdraft: ArchDraftSchema,
  "arch-overlay": ArchOverlaySchema,
  project: ProjectSchema,
  workspace: WorkspaceManifestSchema,
  survey: ArchSurveySchema,
  trace: TraceProfileSchema,
  todos: TodoListSchema,
  agents: AgentRosterSchema,
  enrichment: CodeEnrichmentSchema,
  syslayout: SystemsLayoutSchema,
  services: ServicesFileSchema,
  standing: StandingTasksFileSchema,
} as const;

export interface KindDataMap {
  architecture: ArchitectureGraph;
  archdraft: ArchDraft;
  "arch-overlay": ArchOverlay;
  project: Project;
  workspace: WorkspaceManifest;
  survey: ArchSurvey;
  trace: TraceProfile;
  todos: TodoList;
  agents: AgentRoster;
  enrichment: CodeEnrichment;
  syslayout: SystemsLayout;
  services: ServicesFile;
  standing: StandingTasksFile;
}

/**
 * Kinds whose payload carries its own `schemaVersion` and migrates on read —
 * interchange formats written by external generators (agents, tracers), which
 * evolve independently of the envelope version.
 */
const DATA_MIGRATORS: Partial<Record<CrystalFileKind, (data: unknown) => unknown>> = {
  survey: migrateSurveyData,
  trace: migrateTraceProfileData,
  enrichment: migrateEnrichmentData,
};

export function serializeCrystalFile<K extends CrystalFileKind>(
  kind: K,
  data: KindDataMap[K],
): string {
  return JSON.stringify({ crystal: CRYSTAL_FILE_VERSION, kind, data }, null, 2) + "\n";
}

export class CrystalFileError extends Error {}

export function parseCrystalFile<K extends CrystalFileKind>(
  kind: K,
  text: string,
): KindDataMap[K] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new CrystalFileError(`Not valid JSON: ${(err as Error).message}`);
  }
  const envelope = EnvelopeSchema.safeParse(raw);
  if (!envelope.success) {
    throw new CrystalFileError("Missing crystal file envelope { crystal, kind, data }");
  }
  if (envelope.data.kind !== kind) {
    throw new CrystalFileError(
      `Expected kind "${kind}" but file is "${envelope.data.kind}"`,
    );
  }
  if (envelope.data.crystal > CRYSTAL_FILE_VERSION) {
    throw new CrystalFileError(
      `File version ${envelope.data.crystal} is newer than this build supports (${CRYSTAL_FILE_VERSION})`,
    );
  }
  let data = envelope.data.data;
  const migrate = DATA_MIGRATORS[kind];
  if (migrate) {
    try {
      data = migrate(data);
    } catch (err) {
      throw new CrystalFileError(`Invalid ${kind} data: ${(err as Error).message}`);
    }
  }
  const parsed = DATA_SCHEMAS[kind].safeParse(data);
  if (!parsed.success) {
    throw new CrystalFileError(`Invalid ${kind} data: ${parsed.error.message}`);
  }
  return parsed.data as KindDataMap[K];
}

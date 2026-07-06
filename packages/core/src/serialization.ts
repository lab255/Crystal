import { z } from "zod";
import { ArchDraftSchema, type ArchDraft } from "./arch-draft.js";
import { ArchitectureGraphSchema, type ArchitectureGraph } from "./architecture.js";
import { ProjectSchema, type Project } from "./project.js";
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

export type CrystalFileKind = "architecture" | "archdraft" | "project" | "workspace";

const EnvelopeSchema = z.object({
  crystal: z.number(),
  kind: z.enum(["architecture", "archdraft", "project", "workspace"]),
  data: z.unknown(),
});

const DATA_SCHEMAS = {
  architecture: ArchitectureGraphSchema,
  archdraft: ArchDraftSchema,
  project: ProjectSchema,
  workspace: WorkspaceManifestSchema,
} as const;

export interface KindDataMap {
  architecture: ArchitectureGraph;
  archdraft: ArchDraft;
  project: Project;
  workspace: WorkspaceManifest;
}

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
  const parsed = DATA_SCHEMAS[kind].safeParse(envelope.data.data);
  if (!parsed.success) {
    throw new CrystalFileError(`Invalid ${kind} data: ${parsed.error.message}`);
  }
  return parsed.data as KindDataMap[K];
}

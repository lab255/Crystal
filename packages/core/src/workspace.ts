import { z } from "zod";
import { uid } from "./ids.js";

/**
 * Workspace manifest — `.crystal/workspace.json`.
 *
 * A Crystal workspace is a directory (often a product root) that may contain
 * multiple repos. The manifest names the workspace and registers its repos;
 * architecture graphs and project boards live alongside it in
 * `.crystal/architecture/` and `.crystal/projects/`.
 */

export const RepoRefSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Path relative to the workspace root (repo may be the root itself: "."). */
  path: z.string(),
  remoteUrl: z.string().nullish(),
  defaultBranch: z.string().default("main"),
});
export type RepoRef = z.infer<typeof RepoRefSchema>;

export const WorkspaceManifestSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().default(""),
  repos: z.array(RepoRefSchema).default([]),
});
export type WorkspaceManifest = z.infer<typeof WorkspaceManifestSchema>;

export function createWorkspaceManifest(name: string): WorkspaceManifest {
  return { id: uid("ws"), name, description: "", repos: [] };
}

export function createRepoRef(name: string, path: string): RepoRef {
  return RepoRefSchema.parse({ id: uid("repo"), name, path });
}

/** Well-known paths inside a workspace. */
export const CRYSTAL_DIR = ".crystal";
export const WORKSPACE_FILE = `${CRYSTAL_DIR}/workspace.json`;
export const ARCHITECTURE_DIR = `${CRYSTAL_DIR}/architecture`;
export const ARCH_DRAFTS_DIR = `${ARCHITECTURE_DIR}/drafts`;
export const PROJECTS_DIR = `${CRYSTAL_DIR}/projects`;
/** Per-workspace todo list with traffic-light statuses (see todo.ts). */
export const TODOS_FILE = `${CRYSTAL_DIR}/todos.json`;
/** Where survey agents drop their findings for import (see survey.ts). */
export const SURVEYS_DIR = `${CRYSTAL_DIR}/surveys`;
/** Where runtime trace profiles are dropped for the flamegraph view. */
export const TRACES_DIR = `${CRYSTAL_DIR}/traces`;

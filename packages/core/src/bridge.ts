import type { ArchitectureGraph } from "./architecture.js";
import type { AgentRun, RunEvent } from "./agent.js";
import type { CodeFileDetail, CodeMapSummary, CodeModuleDetail } from "./codemap.js";
import type { Project } from "./project.js";
import type { WorkspaceManifest } from "./workspace.js";

/**
 * Bridge protocol — the JSON message contract between a Crystal UI and a
 * platform host (the Node bridge server over WebSocket today; a Tauri
 * transport can implement the same contract).
 *
 * Requests:  { id, type: "req", method, params }
 * Responses: { id, type: "res", ok: true, result } | { id, type: "res", ok: false, error }
 * Events:    { type: "evt", event, payload }
 */

export interface FileEntry {
  name: string;
  /** Workspace-relative path, always forward-slash separated. */
  path: string;
  kind: "file" | "dir";
  size?: number;
}

export interface GitFileStatus {
  path: string;
  /** Two-letter porcelain code, e.g. " M", "??". */
  code: string;
}

export interface GitStatusResult {
  repoPath: string;
  branch: string | null;
  files: GitFileStatus[];
}

export interface WorkspaceInfo {
  /** Absolute root path on the host. */
  root: string;
  manifest: WorkspaceManifest;
  architectures: { path: string; graph: ArchitectureGraph }[];
  projects: { path: string; project: Project }[];
}

/** Method name → { params, result }. The single source of truth for both sides. */
export interface BridgeMethods {
  "workspace.get": { params: Record<string, never>; result: WorkspaceInfo };
  "workspace.saveManifest": { params: { manifest: WorkspaceManifest }; result: { ok: true } };
  "arch.save": { params: { path: string; graph: ArchitectureGraph }; result: { ok: true } };
  "arch.create": { params: { name: string }; result: { path: string; graph: ArchitectureGraph } };
  "arch.delete": { params: { path: string }; result: { ok: true } };
  "project.save": { params: { path: string; project: Project }; result: { ok: true } };
  "project.create": { params: { name: string }; result: { path: string; project: Project } };
  "fs.list": { params: { path: string }; result: { entries: FileEntry[] } };
  "fs.read": { params: { path: string }; result: { content: string; truncated: boolean } };
  "fs.write": { params: { path: string; content: string }; result: { ok: true } };
  "fs.mkdir": { params: { path: string }; result: { ok: true } };
  "fs.rename": { params: { from: string; to: string }; result: { ok: true } };
  "fs.delete": { params: { path: string }; result: { ok: true } };
  "git.status": { params: { repoPath: string }; result: GitStatusResult };
  "agent.start": {
    params: {
      prompt: string;
      cwd?: string;
      taskId?: string | null;
      projectId?: string | null;
      repoId?: string | null;
      /** Resume a previous Claude Code session. */
      resumeSessionId?: string | null;
      /** "worktree" executes the run in a disposable git worktree. */
      isolation?: "none" | "worktree";
    };
    result: { run: AgentRun };
  };
  "agent.cancel": { params: { runId: string }; result: { ok: true } };
  "agent.list": { params: Record<string, never>; result: { runs: AgentRun[] } };
  "agent.events": { params: { runId: string }; result: { events: RunEvent[] } };
  "agent.diff": {
    params: { runId: string };
    result: { diff: string; stat: string; worktreePath: string | null };
  };
  "agent.cleanupWorktree": { params: { runId: string }; result: { ok: true } };
  "codemap.get": { params: Record<string, never>; result: CodeMapSummary };
  "codemap.module": { params: { path: string }; result: CodeModuleDetail };
  "codemap.file": { params: { path: string }; result: CodeFileDetail };
}

export type BridgeMethodName = keyof BridgeMethods;

export interface BridgeRequest<M extends BridgeMethodName = BridgeMethodName> {
  id: string;
  type: "req";
  method: M;
  params: BridgeMethods[M]["params"];
}

export type BridgeResponse<M extends BridgeMethodName = BridgeMethodName> =
  | { id: string; type: "res"; ok: true; result: BridgeMethods[M]["result"] }
  | { id: string; type: "res"; ok: false; error: { message: string; code?: string } };

/** Server → client push events. */
export interface BridgeEvents {
  "agent.event": RunEvent;
  "agent.runChanged": { run: AgentRun };
  "fs.changed": { paths: string[] };
  "workspace.changed": Record<string, never>;
  /** The derived code map was re-analyzed after source changes. */
  "codemap.changed": Record<string, never>;
}

export type BridgeEventName = keyof BridgeEvents;

export interface BridgeEventMessage<E extends BridgeEventName = BridgeEventName> {
  type: "evt";
  event: E;
  payload: BridgeEvents[E];
}

export type BridgeMessage = BridgeRequest | BridgeResponse | BridgeEventMessage;

export const DEFAULT_BRIDGE_PORT = 4517;
export const BRIDGE_PATH = "/crystal";

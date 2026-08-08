export interface OpenDiffRequest {
  /** Repo-relative path when `repoPath` is set; workspace-relative otherwise. */
  path: string;
  ref: string;
  /** Workspace-relative repository root; omit for the workspace root. */
  repoPath?: string;
}

export const OPEN_DIFF_EVENT = "crystal:open-diff";
export const PENDING_OPEN_DIFF_KEY = "crystal.pendingOpenDiff";

export type DiffSideState =
  | { kind: "text"; content: string }
  | { kind: "absent" }
  | { kind: "truncated" }
  | { kind: "binary"; message: string }
  | { kind: "error"; message: string };

export type DiffPairState =
  | { kind: "ready"; original: string; modified: string; notes: string[] }
  | { kind: "empty"; title: string; detail: string }
  | {
      kind: "unavailable";
      reason: "truncated" | "binary" | "error";
      title: string;
      detail: string;
    };

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

/** Unknown event/storage payload → the narrow request accepted by the diff surface. */
export function shapeDiffRequest(value: unknown): OpenDiffRequest | null {
  const candidate = record(value);
  if (!candidate) return null;
  const path = typeof candidate.path === "string" ? candidate.path.trim() : "";
  const ref = typeof candidate.ref === "string" ? candidate.ref.trim() : "";
  if (!path || !ref) return null;
  const repoPath =
    typeof candidate.repoPath === "string" ? candidate.repoPath.trim().replace(/\\/g, "/") : "";
  return {
    path: path.replace(/\\/g, "/"),
    ref,
    ...(repoPath && repoPath !== "." ? { repoPath: repoPath.replace(/\/$/, "") } : {}),
  };
}

/** `fs.read` is workspace-scoped while a diff request's path is repo-scoped. */
export function currentPathForDiff(request: OpenDiffRequest): string {
  if (!request.repoPath) return request.path;
  return `${request.repoPath}/${request.path}`.replace(/\/{2,}/g, "/");
}

export function baseSideFromRead(read: {
  content: string | null;
  truncated: boolean;
}): DiffSideState {
  if (read.truncated) return { kind: "truncated" };
  return read.content === null ? { kind: "absent" } : { kind: "text", content: read.content };
}

export function currentSideFromRead(read: {
  content: string;
  truncated: boolean;
}): DiffSideState {
  return read.truncated ? { kind: "truncated" } : { kind: "text", content: read.content };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Bridge failures that represent a useful diff state rather than a failed request. */
export function sideFromError(error: unknown, side: "base" | "current"): DiffSideState {
  const message = errorMessage(error);
  if (/\bbinary file\b/i.test(message)) return { kind: "binary", message };
  if (side === "current" && (/\bENOENT\b/.test(message) || /no such file or directory/i.test(message))) {
    return { kind: "absent" };
  }
  return { kind: "error", message };
}

/** Pair the two independently-loaded sides into the exact state the pane renders. */
export function pairDiffSides(base: DiffSideState, current: DiffSideState): DiffPairState {
  const failure = [base, current].find((side) => side.kind === "error");
  if (failure?.kind === "error") {
    return {
      kind: "unavailable",
      reason: "error",
      title: "Could not load this diff",
      detail: failure.message,
    };
  }

  const binary = [base, current].find((side) => side.kind === "binary");
  if (binary?.kind === "binary") {
    return {
      kind: "unavailable",
      reason: "binary",
      title: "Binary file",
      detail: "Crystal cannot render a textual diff for this file.",
    };
  }

  if (base.kind === "truncated" || current.kind === "truncated") {
    const side =
      base.kind === "truncated" && current.kind === "truncated"
        ? "Both versions exceed the file-size limit."
        : base.kind === "truncated"
          ? "The version at the selected ref exceeds the file-size limit."
          : "The worktree version exceeds the file-size limit.";
    return {
      kind: "unavailable",
      reason: "truncated",
      title: "File too large for a safe diff",
      detail: side,
    };
  }

  if (base.kind === "absent" && current.kind === "absent") {
    return {
      kind: "empty",
      title: "File absent on both sides",
      detail: "Neither the selected ref nor the worktree contains this path.",
    };
  }

  const notes: string[] = [];
  if (base.kind === "absent") notes.push("Absent at ref — the left side is empty.");
  if (current.kind === "absent") notes.push("Deleted from the worktree — the right side is empty.");
  return {
    kind: "ready",
    original: base.kind === "text" ? base.content : "",
    modified: current.kind === "text" ? current.content : "",
    notes,
  };
}

interface StoredDiffRequest {
  request?: unknown;
  ws?: unknown;
}

/** Read-once handoff for an editor mode that mounted after the event fired. */
export function consumePendingDiffRequest(activeWs?: string | null): OpenDiffRequest | null {
  try {
    const pending = sessionStorage.getItem(PENDING_OPEN_DIFF_KEY);
    if (!pending) return null;
    sessionStorage.removeItem(PENDING_OPEN_DIFF_KEY);
    const parsed = JSON.parse(pending) as unknown;
    const envelope = record(parsed) as StoredDiffRequest | null;
    if (envelope && "request" in envelope) {
      if (typeof envelope.ws === "string" && activeWs && envelope.ws !== activeWs) return null;
      return shapeDiffRequest(envelope.request);
    }
    return shapeDiffRequest(parsed);
  } catch {
    return null;
  }
}

/**
 * Open a read-only textual diff without coupling the caller to editor state.
 * The empty open-file event asks the shell to reveal the editor without
 * creating a normal file tab.
 */
export function openDiff(request: OpenDiffRequest): void {
  const shaped = shapeDiffRequest(request);
  if (!shaped) return;
  try {
    sessionStorage.setItem(PENDING_OPEN_DIFF_KEY, JSON.stringify(shaped));
  } catch {
    /* storage unavailable — the live listener still works */
  }
  window.dispatchEvent(new CustomEvent("crystal:open-file", { detail: {} }));
  window.dispatchEvent(new CustomEvent(OPEN_DIFF_EVENT, { detail: shaped }));
}

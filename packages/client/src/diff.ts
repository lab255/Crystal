/**
 * Client-side parser for the raw unified-diff blob `agent.diff` returns (one
 * `git diff` over the whole worktree). The server ships the blob untouched;
 * splitting it per file here is what lets the run surface render a file list
 * with expandable hunks — and later hang review verbs off individual files —
 * without any server change.
 */

export type FileDiffStatus = "added" | "deleted" | "modified" | "renamed";

export interface DiffLine {
  kind: "context" | "add" | "del";
  text: string;
}

export interface DiffHunk {
  /** The full `@@ -a,b +c,d @@ …` line, verbatim. */
  header: string;
  lines: DiffLine[];
}

export interface FileDiff {
  /** Path after the change (the pre-image path for deletions). */
  path: string;
  /** Pre-rename path, only when `status` is "renamed". */
  oldPath?: string;
  status: FileDiffStatus;
  /** Binary files carry no hunks — render a notice instead of content. */
  binary: boolean;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
}

/**
 * Strip git's `a/` / `b/` prefix and unquote. `/dev/null` (the pre-image of
 * an added file, the post-image of a deleted one) becomes null.
 */
function cleanPath(raw: string): string | null {
  let p = raw.trim();
  if (p.startsWith('"') && p.endsWith('"') && p.length >= 2) {
    // git quotes paths with spaces/non-ASCII; unescape the common cases.
    p = p.slice(1, -1).replace(/\\([\\"tn])/g, (_, c: string) =>
      c === "t" ? "\t" : c === "n" ? "\n" : c,
    );
  }
  if (p === "/dev/null") return null;
  if (p.startsWith("a/") || p.startsWith("b/")) return p.slice(2);
  return p;
}

/**
 * The two paths out of a `diff --git a/… b/…` header. Only a fallback — the
 * `---`/`+++`/`rename` lines are unambiguous and win when present — so the
 * heuristic for unquoted paths containing spaces (split on the last ` b/`)
 * is acceptable here.
 */
function headerPaths(line: string): { a: string | null; b: string | null } {
  const rest = line.slice("diff --git ".length);
  if (rest.startsWith('"')) {
    // "a/x y" "b/x y" — quoted tokens, split at the closing quote.
    const end = rest.indexOf('" ', 1);
    if (end !== -1) {
      return { a: cleanPath(rest.slice(0, end + 1)), b: cleanPath(rest.slice(end + 2)) };
    }
  }
  const idx = rest.lastIndexOf(" b/");
  if (idx !== -1) {
    return { a: cleanPath(rest.slice(0, idx)), b: cleanPath(rest.slice(idx + 1)) };
  }
  const parts = rest.split(" ");
  return {
    a: parts[0] !== undefined ? cleanPath(parts[0]) : null,
    b: parts[1] !== undefined ? cleanPath(parts[1]) : null,
  };
}

/** Mutable per-file accumulation while walking the blob. */
interface PendingFile {
  headerA: string | null;
  headerB: string | null;
  oldFile: string | null | undefined; // undefined = no `---` line seen; null = /dev/null
  newFile: string | null | undefined;
  renameFrom: string | null;
  renameTo: string | null;
  isNew: boolean;
  isDeleted: boolean;
  binary: boolean;
  hunks: DiffHunk[];
}

function finalize(f: PendingFile): FileDiff | null {
  let additions = 0;
  let deletions = 0;
  for (const hunk of f.hunks) {
    for (const line of hunk.lines) {
      if (line.kind === "add") additions++;
      else if (line.kind === "del") deletions++;
    }
  }
  const oldPath = f.renameFrom ?? (f.oldFile !== undefined ? f.oldFile : f.headerA);
  const newPath = f.renameTo ?? (f.newFile !== undefined ? f.newFile : f.headerB);

  let status: FileDiffStatus;
  let path: string | null;
  if (f.isNew || (oldPath === null && newPath !== null)) {
    status = "added";
    path = newPath;
  } else if (f.isDeleted || (newPath === null && oldPath !== null)) {
    status = "deleted";
    path = oldPath;
  } else if (f.renameFrom !== null || f.renameTo !== null || (oldPath && newPath && oldPath !== newPath)) {
    status = "renamed";
    path = newPath ?? oldPath;
  } else {
    status = "modified";
    path = newPath ?? oldPath;
  }
  if (path === null) return null; // header we couldn't attribute — skip, never throw

  const file: FileDiff = {
    path,
    status,
    binary: f.binary,
    additions,
    deletions,
    hunks: f.hunks,
  };
  if (status === "renamed" && oldPath) file.oldPath = oldPath;
  return file;
}

function newPending(headerLine: string): PendingFile {
  const { a, b } = headerPaths(headerLine);
  return {
    headerA: a,
    headerB: b,
    oldFile: undefined,
    newFile: undefined,
    renameFrom: null,
    renameTo: null,
    isNew: false,
    isDeleted: false,
    binary: false,
    hunks: [],
  };
}

/**
 * Split one raw unified-diff blob (git flavor) into per-file entries. Handles
 * added/deleted files (`/dev/null` sides), renames (with or without content
 * hunks), binary-file notices, and quoted paths. Never throws — unrecognized
 * lines are skipped, so a surprising diff degrades to fewer details, not a
 * blank Changes pane.
 */
export function parseUnifiedDiff(blob: string): FileDiff[] {
  const files: FileDiff[] = [];
  let current: PendingFile | null = null;
  let hunk: DiffHunk | null = null;

  const push = () => {
    if (!current) return;
    const done = finalize(current);
    if (done) files.push(done);
    current = null;
    hunk = null;
  };

  for (const line of blob.split("\n")) {
    if (line.startsWith("diff --git ")) {
      push();
      current = newPending(line);
      continue;
    }
    if (!current) continue;

    if (hunk) {
      // Inside a hunk body until a line that can't belong to it.
      const c = line[0];
      if (c === "+") {
        hunk.lines.push({ kind: "add", text: line.slice(1) });
        continue;
      }
      if (c === "-") {
        hunk.lines.push({ kind: "del", text: line.slice(1) });
        continue;
      }
      if (c === " " || line === "") {
        hunk.lines.push({ kind: "context", text: line.slice(1) });
        continue;
      }
      if (c === "\\") continue; // "\ No newline at end of file" — metadata, not content
      hunk = null; // falls through: the line belongs to file-level parsing
    }

    if (line.startsWith("@@")) {
      hunk = { header: line, lines: [] };
      current.hunks.push(hunk);
    } else if (line.startsWith("--- ")) {
      current.oldFile = cleanPath(line.slice(4));
    } else if (line.startsWith("+++ ")) {
      current.newFile = cleanPath(line.slice(4));
    } else if (line.startsWith("new file mode")) {
      current.isNew = true;
    } else if (line.startsWith("deleted file mode")) {
      current.isDeleted = true;
    } else if (line.startsWith("rename from ")) {
      current.renameFrom = cleanPath(line.slice("rename from ".length));
    } else if (line.startsWith("rename to ")) {
      current.renameTo = cleanPath(line.slice("rename to ".length));
    } else if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
      current.binary = true;
      if (line.startsWith("Binary files ")) {
        // `Binary files a/x and b/x differ` — the only path source for
        // binaries (they carry no ---/+++ lines).
        const body = line.slice("Binary files ".length).replace(/ differ$/, "");
        const at = body.lastIndexOf(" and ");
        if (at !== -1) {
          if (current.oldFile === undefined) current.oldFile = cleanPath(body.slice(0, at));
          if (current.newFile === undefined) current.newFile = cleanPath(body.slice(at + 5));
        }
      }
    }
    // index/mode/similarity lines: nothing to record.
  }
  push();
  return files;
}

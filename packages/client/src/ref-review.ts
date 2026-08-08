import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BridgeMethods } from "@crystal/core";
import { useCrystal, useWorkspaces } from "./provider.js";

/**
 * The one "vs <ref>" state machine. Every diagram's ref review — codebase,
 * architecture, infra — drives the shared `RefReviewBar` with this hook: the
 * deep-link `vs` param is the source of truth (start/exit just write it), the
 * hook resolves it to a `codemap.snapshotAtRef` bundle scoped to what the
 * view actually projects from (`need`), and re-resolves when the code map
 * re-analyzes so the changed-file marks follow the edit stream. Diffing the
 * bundle against live data stays in the view (pure core functions).
 */

export type RefSnapshotNeed = "summary" | "overview" | "surfaces";
export type RefSnapshot = BridgeMethods["codemap.snapshotAtRef"]["result"];
export type RefReviewDirection = "worktree" | "of-ref";
export type RefReviewFile =
  | RefSnapshot["changedFiles"][number]
  | { path: string; status: "changed" };

export interface ActiveRefReview {
  ref: string;
  commit: string | null;
  files: RefReviewFile[];
  fileDirection: RefReviewDirection;
  setFileDirection: (direction: RefReviewDirection) => void;
  filesLoading: boolean;
  filesError: string | null;
  /** Open this review's ref-vs-worktree textual diff. */
  openDiff: (path: string) => void;
}

export interface RefReviewState {
  /** The running review (param + resolved commit), or null when idle. */
  active: ActiveRefReview | null;
  /** The base-side bundle, present once resolved (holds the last value across refreshes). */
  snapshot: RefSnapshot | null;
  loading: boolean;
  error: string | null;
  start: (ref: string) => void;
  exit: () => void;
}

export function useRefReview(opts: {
  /** The `vs` deep-link param (nav-store owned — never component state). */
  param: string | null | undefined;
  setParam: (ref: string | null) => void;
  /** Projections this view diffs against; keep the array literal stable or memoized. */
  need: readonly RefSnapshotNeed[];
  /** Repo to snapshot, workspace-relative; omit for the workspace root. */
  repoPath?: string;
}): RefReviewState {
  const { param, setParam, repoPath } = opts;
  const ref = param?.trim() ? param.trim() : null;
  const { client } = useCrystal();
  const activeWs = useWorkspaces((s) => s.activeId);

  const [snapshot, setSnapshot] = useState<RefSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const [fileDirection, setFileDirection] = useState<RefReviewDirection>("worktree");
  const [ofRefFiles, setOfRefFiles] = useState<RefReviewFile[]>([]);
  const [ofRefLoading, setOfRefLoading] = useState(false);
  const [ofRefError, setOfRefError] = useState<string | null>(null);
  const ofRefGeneration = useRef(0);

  // `need` is order-insensitive identity; a re-created array must not refetch.
  const needKey = [...opts.need].sort().join("+");

  const fetchSnapshot = useCallback(() => {
    const gen = ++generation.current;
    if (!ref || !activeWs) {
      setSnapshot(null);
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    client
      .request("codemap.snapshotAtRef", {
        ref,
        need: needKey.split("+") as RefSnapshotNeed[],
        ...(repoPath ? { repoPath } : {}),
      })
      .then((result) => {
        if (generation.current !== gen) return;
        setSnapshot(result);
        setLoading(false);
      })
      .catch((err: Error) => {
        if (generation.current !== gen) return;
        setSnapshot(null);
        setLoading(false);
        setError(err.message);
      });
  }, [client, ref, activeWs, needKey, repoPath]);

  useEffect(() => {
    fetchSnapshot();
  }, [fetchSnapshot]);

  useEffect(() => {
    setFileDirection("worktree");
    setOfRefFiles([]);
    setOfRefError(null);
    setOfRefLoading(false);
    ofRefGeneration.current += 1;
  }, [ref]);

  // The worktree half of the diff moves with every edit — refresh the
  // changed-file resolution (the ref side is LRU-cached per commit).
  useEffect(() => {
    if (!ref) return;
    return client.events.on("codemap.changed", ({ ws }) => {
      if (ws === activeWs) fetchSnapshot();
    });
  }, [client, ref, activeWs, fetchSnapshot]);

  useEffect(() => {
    const gen = ++ofRefGeneration.current;
    if (!ref || !activeWs || fileDirection !== "of-ref") {
      setOfRefLoading(false);
      return;
    }
    setOfRefLoading(true);
    setOfRefError(null);
    client
      .request("git.changedFiles", {
        scope: "base",
        ofRef: ref,
        ...(repoPath ? { repoPath } : {}),
      })
      .then(({ files }) => {
        if (ofRefGeneration.current !== gen) return;
        // This bridge path deliberately returns names only. "changed" is an
        // honest status; guessing add/delete from a name would mislead review.
        setOfRefFiles(files.map((path) => ({ path, status: "changed" as const })));
        setOfRefLoading(false);
      })
      .catch((err: Error) => {
        if (ofRefGeneration.current !== gen) return;
        setOfRefFiles([]);
        setOfRefLoading(false);
        setOfRefError(err.message);
      });
  }, [client, ref, activeWs, fileDirection, repoPath]);

  const start = useCallback((next: string) => setParam(next.trim() || null), [setParam]);
  const exit = useCallback(() => setParam(null), [setParam]);

  const openDiff = useCallback(
    (path: string) => {
      if (!ref) return;
      const request = { path, ref, ...(repoPath ? { repoPath } : {}) };
      try {
        sessionStorage.setItem(
          "crystal.pendingOpenDiff",
          JSON.stringify({ request, ws: activeWs ?? undefined }),
        );
      } catch {
        /* storage unavailable — the live listener still works */
      }
      // The shell already owns this event as the cross-mode path to `code`.
      // An empty detail switches modes without creating a normal file tab.
      window.dispatchEvent(new CustomEvent("crystal:open-file", { detail: {} }));
      window.dispatchEvent(new CustomEvent("crystal:open-diff", { detail: request }));
    },
    [ref, repoPath, activeWs],
  );

  const active = useMemo(
    () =>
      ref
        ? {
            ref,
            commit: snapshot?.commit ?? null,
            files:
              fileDirection === "worktree" ? (snapshot?.changedFiles ?? []) : ofRefFiles,
            fileDirection,
            setFileDirection,
            filesLoading: fileDirection === "worktree" ? loading : ofRefLoading,
            filesError: fileDirection === "worktree" ? null : ofRefError,
            openDiff,
          }
        : null,
    [
      ref,
      snapshot?.commit,
      snapshot?.changedFiles,
      fileDirection,
      ofRefFiles,
      loading,
      ofRefLoading,
      ofRefError,
      openDiff,
    ],
  );

  return { active, snapshot: ref ? snapshot : null, loading, error, start, exit };
}

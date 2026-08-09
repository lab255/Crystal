import type {
  MergePreviewResult,
  MergeResult,
  SyncPreviewResult,
  SyncResult,
} from "@crystal/core";
import { gitCurrentBranch, gitWorktrees, runGit } from "./git.js";

/**
 * Worktree merge-back — landing an isolated run's work onto the repo's
 * current branch.
 *
 * The target is always the branch checked out in the *main* repo working
 * tree: that is where the run branched from and where the user expects the
 * work to land. Two mechanisms, picked by where the target lives:
 *
 *  - Target checked out somewhere (the normal case): a real `git merge` runs
 *    in that checkout, so its working tree and index stay in sync. Git itself
 *    refuses when local changes would be clobbered.
 *  - Target not checked out anywhere: an object-level merge — `git merge-tree
 *    --write-tree` computes the merged tree with no working tree at all,
 *    `commit-tree` wraps it, and `update-ref <target> <new> <oldTip>`
 *    advances the branch atomically (CAS: refuses if the branch moved).
 *
 * Conflicts are *predicted* before anything mutates (`merge-tree` again —
 * non-destructive), so the UI can offer "resolve with an agent" instead of
 * failing: the resolution flow replays the merge the other direction (target
 * INTO the run's worktree), leaves standard conflict markers for an agent to
 * resolve and commit, after which landing is a fast-forward. Aborting a
 * resolution is plain `git merge --abort` — nothing is committed until the
 * resolution is done, so there is nothing else to undo.
 */

/** The bridge type is the single source of truth — this module implements it. */
export type MergePreview = MergePreviewResult;
export type SyncPreview = SyncPreviewResult;
export type { MergeResult, SyncResult };

/** Thrown by `mergeWorktree` when the (re-)prediction finds conflicts. */
export class MergeConflictError extends Error {
  constructor(readonly conflicts: string[]) {
    super(
      `Merge would conflict in ${conflicts.length} file${conflicts.length === 1 ? "" : "s"}: ` +
        conflicts.slice(0, 8).join(", ") +
        (conflicts.length > 8 ? ", …" : ""),
    );
  }
}

/**
 * Parse `git merge-tree --write-tree --name-only` stdout: the merged tree oid
 * on the first line, then conflicted filenames until a blank line separates
 * the informational messages. Exported for tests.
 */
export function parseMergeTreeOutput(stdout: string): { tree: string; conflicts: string[] } {
  const lines = stdout.split("\n");
  const tree = lines[0]?.trim() ?? "";
  const conflicts: string[] = [];
  for (const line of lines.slice(1)) {
    if (!line.trim()) break;
    if (!conflicts.includes(line)) conflicts.push(line);
  }
  return { tree, conflicts };
}

async function revParse(cwd: string, ref: string): Promise<string | null> {
  try {
    return (await runGit(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])).trim() || null;
  } catch {
    return null;
  }
}

/** Absolute path of the worktree that has `branch` checked out, if any. */
export async function findCheckoutDir(repoAbs: string, branch: string): Promise<string | null> {
  return (await gitWorktrees(repoAbs)).find((w) => w.branch === branch)?.path ?? null;
}

async function isDirty(worktreeAbs: string): Promise<boolean> {
  const out = await runGit(worktreeAbs, ["status", "--porcelain"]);
  return out.trim().length > 0;
}

async function isResolving(worktreeAbs: string): Promise<boolean> {
  return (await revParse(worktreeAbs, "MERGE_HEAD")) != null;
}

async function conflictedPaths(worktreeAbs: string): Promise<string[]> {
  const out = await runGit(worktreeAbs, ["diff", "--name-only", "--diff-filter=U"]).catch(() => "");
  return out.split("\n").filter(Boolean);
}

/** left-only = behind, right-only = ahead. */
async function divergence(
  cwd: string,
  left: string,
  right: string,
): Promise<{ behind: number; ahead: number }> {
  const counts = (await runGit(cwd, [
    "rev-list",
    "--left-right",
    "--count",
    `${left}...${right}`,
  ]).catch(() => "0\t0")).trim();
  const [behind = 0, ahead = 0] = counts.split(/\s+/).map((n) => Number(n) || 0);
  return { behind, ahead };
}

/**
 * Predict the merge of `head` onto `target` without touching anything.
 * `merge-tree --write-tree` exits 1 on conflicts (with the conflict list on
 * stdout); the `--name-only` conflict list needs git ≥ 2.40 (the tree write
 * itself is ≥ 2.38) — older gits surface as prediction-unavailable
 * rather than an error.
 */
async function predictMerge(
  cwd: string,
  target: string,
  head: string,
): Promise<{ tree: string | null; conflicts: string[]; unavailable: boolean }> {
  try {
    const out = await runGit(cwd, ["merge-tree", "--write-tree", "--name-only", target, head]);
    return { tree: parseMergeTreeOutput(out).tree, conflicts: [], unavailable: false };
  } catch (err) {
    const e = err as Error & { code?: number; stdout?: string };
    // Exit 1 = merged with conflicts; stdout still carries tree + file list.
    if (e.code === 1 && typeof e.stdout === "string" && e.stdout.trim()) {
      const { tree, conflicts } = parseMergeTreeOutput(e.stdout);
      return { tree, conflicts, unavailable: false };
    }
    return { tree: null, conflicts: [], unavailable: true };
  }
}

/**
 * Resolve the merge target: an explicit branch when given (must exist),
 * otherwise the main repo's current branch.
 */
async function resolveTarget(
  repoAbs: string,
  explicit: string | null | undefined,
): Promise<{ target: string } | { target: null; reason: string }> {
  if (explicit) {
    if ((await revParse(repoAbs, `refs/heads/${explicit}`)) == null) {
      return { target: null, reason: `No local branch named "${explicit}".` };
    }
    return { target: explicit };
  }
  const current = await gitCurrentBranch(repoAbs);
  return current
    ? { target: current }
    : { target: null, reason: "The repo is on a detached HEAD — pick a branch to merge into." };
}

export async function mergePreview(
  repoAbs: string,
  worktreeAbs: string,
  explicitTarget?: string | null,
): Promise<MergePreview> {
  return (await mergePreviewEx(repoAbs, worktreeAbs, explicitTarget)).preview;
}

/**
 * Preview plus the predicted merged tree oid (when a true-merge prediction
 * ran) — `mergeWorktree` reuses it so `merge-tree` (a full recursive merge,
 * the most expensive call in the flow) runs once, not twice.
 */
async function mergePreviewEx(
  repoAbs: string,
  worktreeAbs: string,
  explicitTarget?: string | null,
): Promise<{ preview: MergePreview; tree: string | null }> {
  const empty: Omit<MergePreview, "canMerge" | "reason"> = {
    target: null,
    baseTip: null,
    head: null,
    ahead: 0,
    behind: 0,
    dirty: false,
    conflicts: [],
    resolving: false,
    predictionUnavailable: false,
  };
  const resolved = await resolveTarget(repoAbs, explicitTarget);
  if (resolved.target == null) {
    return { preview: { ...empty, canMerge: false, reason: resolved.reason }, tree: null };
  }
  const target = resolved.target;
  const [baseTip, head, dirty, resolving] = await Promise.all([
    revParse(repoAbs, target),
    revParse(worktreeAbs, "HEAD"),
    isDirty(worktreeAbs),
    isResolving(worktreeAbs),
  ]);
  if (!baseTip || !head) {
    return {
      preview: { ...empty, target, canMerge: false, reason: "Could not resolve the branch tips." },
      tree: null,
    };
  }
  // left = commits only in target (behind), right = only in HEAD (ahead).
  const { behind, ahead } = await divergence(worktreeAbs, baseTip, head);

  if (resolving) {
    return {
      preview: {
        ...empty, target, baseTip, head, ahead, behind, dirty, resolving,
        canMerge: false,
        reason: "Conflict resolution is in progress — merge once it is committed (or abort it).",
      },
      tree: null,
    };
  }
  if (ahead === 0 && !dirty) {
    return {
      preview: {
        ...empty, target, baseTip, head, ahead, behind,
        canMerge: false,
        reason: "Nothing to merge — the worktree has no commits or changes beyond the target.",
      },
      tree: null,
    };
  }
  // A fast-forward (behind = 0) cannot conflict; only true merges need prediction.
  const prediction =
    behind > 0
      ? await predictMerge(worktreeAbs, baseTip, head)
      : { tree: null, conflicts: [], unavailable: false };
  return {
    preview: {
      ...empty, target, baseTip, head, ahead, behind, dirty,
      conflicts: prediction.conflicts,
      predictionUnavailable: prediction.unavailable,
      canMerge: prediction.conflicts.length === 0,
      reason:
        prediction.conflicts.length > 0
          ? `Would conflict in ${prediction.conflicts.length} file${prediction.conflicts.length === 1 ? "" : "s"}.`
          : null,
    },
    tree: prediction.tree ?? null,
  };
}

/**
 * Predict merging the merge target INTO the run's worktree. Like
 * `mergePreview`, this only reads refs/the worktree and asks merge-tree for a
 * result; it never moves a ref, index, or working-tree file.
 */
export async function syncPreview(
  repoAbs: string,
  worktreeAbs: string,
  explicitTarget?: string | null,
): Promise<SyncPreview> {
  return (await syncPreviewEx(repoAbs, worktreeAbs, explicitTarget)).preview;
}

async function syncPreviewEx(
  repoAbs: string,
  worktreeAbs: string,
  explicitTarget?: string | null,
): Promise<{
  preview: SyncPreview;
  head: string;
}> {
  const resolved = await resolveTarget(repoAbs, explicitTarget);
  if (resolved.target == null) throw new Error(resolved.reason);
  const target = resolved.target;
  const [baseTip, head, dirty] = await Promise.all([
    revParse(repoAbs, target),
    revParse(worktreeAbs, "HEAD"),
    isDirty(worktreeAbs),
  ]);
  if (!baseTip || !head) throw new Error("Could not resolve the branch tips.");
  const { behind, ahead } = await divergence(worktreeAbs, baseTip, head);
  // A worktree with no unique commits can move directly to the target. Dirty
  // state deliberately disables that tier even when git might preserve it.
  const canFastForward = ahead === 0 && !dirty;
  const prediction =
    behind > 0 && ahead > 0
      ? await predictMerge(worktreeAbs, head, baseTip)
      : { tree: null, conflicts: [], unavailable: false };
  return {
    preview: {
      target,
      baseTip,
      ahead,
      behind,
      dirty,
      canFastForward,
      conflicts: prediction.conflicts,
    },
    head,
  };
}

/**
 * Explicitly merge the target branch into the run's worktree. Clean
 * fast-forwards use `--ff-only`; divergent clean histories receive a merge
 * commit; conflicts remain materialized for the existing resolver/abort
 * flow. Dirty or untracked work is a typed refusal in v1.
 */
export async function syncWorktree(
  repoAbs: string,
  worktreeAbs: string,
  explicitTarget?: string | null,
): Promise<SyncResult> {
  await abortIfResolvingForSync(worktreeAbs);
  const { preview, head } = await syncPreviewEx(
    repoAbs,
    worktreeAbs,
    explicitTarget,
  );
  const { target, baseTip, behind, dirty, canFastForward, conflicts } = preview;
  if (behind === 0) {
    return { ok: true, target, syncedCommit: head, fastForward: true, conflicts: [] };
  }
  if (dirty) {
    return {
      ok: false,
      error: "The worktree has uncommitted or untracked changes — commit or discard first.",
    };
  }
  if (conflicts.length > 0) {
    const prep = await prepareConflictResolution(repoAbs, worktreeAbs, {
      commitMessage: `Sync ${target} into run worktree`,
      target,
    });
    return {
      ok: true,
      target,
      syncedCommit: prep.conflicts.length === 0 ? await revParse(worktreeAbs, "HEAD") : null,
      fastForward: false,
      conflicts: prep.conflicts,
    };
  }
  if (canFastForward) {
    await runGit(worktreeAbs, ["merge", "--ff-only", baseTip]);
    return {
      ok: true,
      target,
      syncedCommit: await revParse(worktreeAbs, "HEAD"),
      fastForward: true,
      conflicts: [],
    };
  }

  try {
    await runGit(worktreeAbs, [
      "-c", "user.name=Crystal",
      "-c", "user.email=crystal@local",
      "merge", "--no-ff", "-m", `Merge ${target} into run worktree`, baseTip,
    ]);
  } catch (err) {
    // The target may have raced the prediction. Preserve real conflicts for
    // the resolver; clean up failures that did not produce a merge state.
    const actualConflicts = await conflictedPaths(worktreeAbs);
    if (actualConflicts.length > 0) {
      return {
        ok: true,
        target,
        syncedCommit: null,
        fastForward: false,
        conflicts: actualConflicts,
      };
    }
    await runGit(worktreeAbs, ["merge", "--abort"]).catch(() => {});
    throw new Error(`Could not sync ${target} into the worktree: ${(err as Error).message}`);
  }
  return {
    ok: true,
    target,
    syncedCommit: await revParse(worktreeAbs, "HEAD"),
    fastForward: false,
    conflicts: [],
  };
}

/**
 * Commit any uncommitted worktree changes so the merge has a real commit to
 * land. Retries with a fallback identity for repos with no configured user.
 */
async function autoCommit(worktreeAbs: string, message: string): Promise<void> {
  if (!(await isDirty(worktreeAbs))) return;
  await runGit(worktreeAbs, ["add", "-A"]);
  try {
    await runGit(worktreeAbs, ["commit", "-m", message, "--no-verify"]);
  } catch {
    await runGit(worktreeAbs, [
      "-c", "user.name=Crystal",
      "-c", "user.email=crystal@local",
      "commit", "-m", message, "--no-verify",
    ]);
  }
}

/**
 * Land the worktree's work on the repo's current branch. Auto-commits dirty
 * state, re-predicts conflicts (throws {@link MergeConflictError} so the
 * caller can route to resolution), then merges in the target's checkout when
 * it has one, or object-level when it doesn't.
 */
export async function mergeWorktree(
  repoAbs: string,
  worktreeAbs: string,
  opts: { message: string; commitMessage?: string; target?: string | null },
): Promise<MergeResult> {
  await abortIfResolving(worktreeAbs);
  await autoCommit(worktreeAbs, opts.commitMessage ?? opts.message);

  const { preview, tree } = await mergePreviewEx(repoAbs, worktreeAbs, opts.target);
  if (!preview.target || !preview.baseTip || !preview.head) {
    throw new Error(preview.reason ?? "Could not compute the merge.");
  }
  if (preview.conflicts.length > 0) throw new MergeConflictError(preview.conflicts);
  if (!preview.canMerge) throw new Error(preview.reason ?? "Nothing to merge.");
  const { target, baseTip, head, behind } = preview;

  const checkoutDir = await findCheckoutDir(repoAbs, target);
  if (checkoutDir) {
    // Real merge in the target's checkout: keeps its working tree and index
    // coherent. On a surprise conflict (dirty checkout, racing commit) the
    // merge aborts so the user's tree is never left half-merged.
    try {
      await runGit(checkoutDir, [
        "merge",
        ...(behind === 0 ? ["--ff"] : ["--no-ff"]),
        "-m", opts.message,
        head,
      ]);
    } catch (err) {
      await runGit(checkoutDir, ["merge", "--abort"]).catch(() => {});
      throw new Error(`Merge failed in ${checkoutDir}: ${(err as Error).message}`);
    }
    const merged = (await revParse(checkoutDir, "HEAD"))!;
    return { target, mergedCommit: merged, fastForward: behind === 0 };
  }

  // No checkout anywhere: object-level, no working tree ever materializes.
  if (behind === 0) {
    // Pure fast-forward — the branch just moves up to the worktree's HEAD.
    await runGit(worktreeAbs, ["update-ref", `refs/heads/${target}`, head, baseTip]);
    return { target, mergedCommit: head, fastForward: true };
  }
  // The preview already ran the (expensive) merge-tree prediction — reuse it.
  if (preview.predictionUnavailable || !tree) {
    throw new Error(
      "This merge needs `git merge-tree --write-tree --name-only` (git ≥ 2.40) because the target branch has no checkout. Update git, or check the branch out so the merge runs in its working tree.",
    );
  }
  const commit = (
    await runGit(worktreeAbs, [
      "-c", "user.name=Crystal",
      "-c", "user.email=crystal@local",
      "commit-tree", tree,
      "-p", baseTip,
      "-p", head,
      "-m", opts.message,
    ])
  ).trim();
  // CAS: refuses if the branch moved since we read baseTip.
  await runGit(worktreeAbs, ["update-ref", `refs/heads/${target}`, commit, baseTip]);
  return { target, mergedCommit: commit, fastForward: false };
}

async function abortIfResolving(worktreeAbs: string): Promise<void> {
  if (await isResolving(worktreeAbs)) {
    throw new Error("Conflict resolution is in progress — commit it (or abort) before merging.");
  }
}

async function abortIfResolvingForSync(worktreeAbs: string): Promise<void> {
  if (await isResolving(worktreeAbs)) {
    throw new Error("Conflict resolution is in progress — commit it (or abort) before syncing.");
  }
}

/**
 * Start conflict resolution: replay the merge the other direction (target
 * INTO the run's worktree), leaving standard conflict markers for an agent —
 * or the user — to resolve and commit. Once the reverse merge is committed
 * the worktree contains both sides and landing becomes a fast-forward.
 * Returns the conflicted paths (empty when the reverse merge applied clean).
 */
export async function prepareConflictResolution(
  repoAbs: string,
  worktreeAbs: string,
  opts: { commitMessage: string; target?: string | null },
): Promise<{ target: string; conflicts: string[] }> {
  const resolved = await resolveTarget(repoAbs, opts.target);
  if (resolved.target == null) throw new Error(resolved.reason);
  const target = resolved.target;
  // A sync may already have materialized this exact reverse merge. Reuse its
  // standard git state instead of trying to begin a second merge.
  if (await isResolving(worktreeAbs)) {
    const conflicts = await conflictedPaths(worktreeAbs);
    if (conflicts.length === 0) {
      throw new Error("A merge is already in progress, but it has no unresolved files.");
    }
    return { target, conflicts };
  }
  const baseTip = await revParse(repoAbs, target);
  if (!baseTip) throw new Error(`Could not resolve branch ${target}.`);
  await autoCommit(worktreeAbs, opts.commitMessage);
  try {
    await runGit(worktreeAbs, [
      "-c", "user.name=Crystal",
      "-c", "user.email=crystal@local",
      "merge", "--no-ff", "-m", `Merge ${target} into run worktree`, baseTip,
    ]);
    return { target, conflicts: [] }; // applied clean after all
  } catch {
    const conflicts = await conflictedPaths(worktreeAbs);
    if (conflicts.length === 0) {
      // The merge failed for some other reason (not conflicts) — clean up.
      await runGit(worktreeAbs, ["merge", "--abort"]).catch(() => {});
      throw new Error("Could not start the reverse merge in the worktree.");
    }
    return { target, conflicts };
  }
}

/** Abort an in-progress conflict resolution (no-op when none is running). */
export async function abortConflictResolution(worktreeAbs: string): Promise<void> {
  if (await isResolving(worktreeAbs)) {
    await runGit(worktreeAbs, ["merge", "--abort"]);
  }
}

/** The prompt for a conflict-resolution agent run inside the worktree. */
export function buildConflictPrompt(target: string, conflicts: string[]): string {
  return [
    `A merge of branch "${target}" into this worktree stopped on conflicts. Resolve them.`,
    "",
    "Conflicted files:",
    ...conflicts.map((f) => `- ${f}`),
    "",
    "For each file: read it, understand BOTH sides (ours = this worktree's work, " +
      "theirs = the target branch), and produce the version that keeps both intents. " +
      "Never delete one side blindly and never leave conflict markers behind.",
    "When every file is resolved: `git add` the resolved files and conclude the merge " +
      "with `git commit` (no message needed — git supplies the merge message). " +
      "Then verify the tree builds/tests if quick to do.",
    "Do NOT push, do not switch branches, and do not touch files outside the conflict set " +
      "unless a resolution genuinely requires it.",
  ].join("\n");
}

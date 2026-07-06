import { useCallback, useEffect, useState } from "react";
import {
  createArchDraft as newArchDraft,
  createMoveFileIntent,
  createMoveIntent,
  type ArchDraft,
  type HoistIntent,
} from "@crystal/core";
import { useWorkspace } from "@crystal/client";
import type { SymbolDragPayload } from "./codemap/CodeNode.js";
import type { DropTarget } from "./codemap/map-model.js";

const EMPTY_DRAFTS: never[] = [];
const EMPTY_ARCHITECTURES: never[] = [];

/**
 * Drag-a-symbol/file refactor intents (plan mode), shared by the unified
 * diagram canvas and the code map. Dropping with no draft open *enters plan
 * mode*: a draft is auto-created against the first architecture, and the
 * shell learns about it through `onOpenDraft`.
 */
export function useRefactorIntents({
  activeDraftPath,
  onOpenDraft,
}: {
  activeDraftPath?: string | null;
  onOpenDraft?: (path: string) => void;
}) {
  const archDrafts = useWorkspace((s) => s.info?.archDrafts ?? EMPTY_DRAFTS);
  const architectures = useWorkspace((s) => s.info?.architectures ?? EMPTY_ARCHITECTURES);
  const updateArchDraft = useWorkspace((s) => s.updateArchDraft);
  const createDraftFile = useWorkspace((s) => s.createArchDraft);

  const activeDraft = archDrafts.find((d) => d.path === activeDraftPath) ?? null;
  const [dropNotice, setDropNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!dropNotice) return;
    const t = setTimeout(() => setDropNotice(null), 8000);
    return () => clearTimeout(t);
  }, [dropNotice]);

  const ensureDraft = useCallback(async (): Promise<{ path: string; draft: ArchDraft } | null> => {
    if (activeDraft) return activeDraft;
    const arch = architectures[0];
    if (!arch) {
      setDropNotice("Create an architecture first — refactor plans ride on draft plans.");
      return null;
    }
    const draft = newArchDraft("Refactor plan", arch.path, arch.graph, new Date().toISOString());
    const created = await createDraftFile(draft);
    onOpenDraft?.(created.path);
    return created;
  }, [activeDraft, architectures, createDraftFile, onOpenDraft]);

  const noticePrefix = useCallback(
    (holder: { draft: ArchDraft }) =>
      activeDraft ? `Draft "${holder.draft.name}"` : `Plan mode — draft "${holder.draft.name}" created`,
    [activeDraft],
  );

  const recordMove = useCallback(
    async (payload: SymbolDragPayload, target: DropTarget) => {
      if (target.file === payload.file) return;
      const holder = await ensureDraft();
      if (!holder) return;
      const intent = createMoveIntent(payload.symbol, payload.file, target.module, target.file ?? null);
      updateArchDraft(holder.path, {
        ...holder.draft,
        refactors: [...holder.draft.refactors, intent],
        updatedAt: new Date().toISOString(),
      });
      setDropNotice(
        `${noticePrefix(holder)}: move ${payload.symbol} → ${target.file ?? target.module}. Apply the draft to run the refactor.`,
      );
    },
    [ensureDraft, noticePrefix, updateArchDraft],
  );

  const recordFileMove = useCallback(
    async (fromFile: string, toModule: string) => {
      const holder = await ensureDraft();
      if (!holder) return;
      const intent = createMoveFileIntent(fromFile, toModule);
      updateArchDraft(holder.path, {
        ...holder.draft,
        refactors: [...holder.draft.refactors, intent],
        updatedAt: new Date().toISOString(),
      });
      setDropNotice(
        `${noticePrefix(holder)}: move file ${fromFile.split("/").pop()} → ${toModule}. Apply the draft to run the refactor.`,
      );
    },
    [ensureDraft, noticePrefix, updateArchDraft],
  );

  const recordHoist = useCallback(
    async (intent: HoistIntent) => {
      const holder = await ensureDraft();
      if (!holder) return;
      updateArchDraft(holder.path, {
        ...holder.draft,
        refactors: [...holder.draft.refactors, intent],
        updatedAt: new Date().toISOString(),
      });
      setDropNotice(`${noticePrefix(holder)}: hoist → ${intent.targetModule}. Apply the draft to run it.`);
    },
    [ensureDraft, noticePrefix, updateArchDraft],
  );

  return { activeDraft, dropNotice, setDropNotice, recordMove, recordFileMove, recordHoist };
}

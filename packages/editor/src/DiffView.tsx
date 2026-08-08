import { DiffEditor } from "@monaco-editor/react";
import { useEffect, useMemo, useState } from "react";
import { FileWarning } from "lucide-react";
import { useCrystal } from "@crystal/client";
import { EmptyState, Spinner } from "@crystal/ui";
import {
  baseSideFromRead,
  currentPathForDiff,
  currentSideFromRead,
  pairDiffSides,
  sideFromError,
  type DiffPairState,
  type DiffSideState,
  type OpenDiffRequest,
} from "./diff-view.js";

function modelPath(side: "base" | "worktree", request: OpenDiffRequest): string {
  const sourcePath = request.repoPath ? `${request.repoPath}/${request.path}` : request.path;
  const encodedPath = sourcePath.split("/").map(encodeURIComponent).join("/");
  return `crystal-diff:///${encodeURIComponent(request.ref)}/${side}/${encodedPath}`;
}

export function DiffView({ request }: { request: OpenDiffRequest }) {
  const { client } = useCrystal();
  const [state, setState] = useState<DiffPairState | null>(null);

  useEffect(() => {
    let current = true;
    setState(null);
    const scope = request.repoPath ? { repoPath: request.repoPath } : {};
    void Promise.allSettled([
      client.request("git.showFile", { ...scope, path: request.path, ref: request.ref }),
      client.request("fs.read", { path: currentPathForDiff(request) }),
    ]).then(([baseResult, currentResult]) => {
      if (!current) return;
      const base: DiffSideState =
        baseResult.status === "fulfilled"
          ? baseSideFromRead(baseResult.value)
          : sideFromError(baseResult.reason, "base");
      const worktree: DiffSideState =
        currentResult.status === "fulfilled"
          ? currentSideFromRead(currentResult.value)
          : sideFromError(currentResult.reason, "current");
      setState(pairDiffSides(base, worktree));
    });
    return () => {
      current = false;
    };
  }, [client, request.path, request.ref, request.repoPath]);

  const paths = useMemo(
    () => ({
      original: modelPath("base", request),
      modified: modelPath("worktree", request),
    }),
    [request],
  );

  if (!state) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }

  if (state.kind !== "ready") {
    return (
      <EmptyState icon={FileWarning} title={state.title}>
        {state.detail}
      </EmptyState>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface-0">
      <div className="grid grid-cols-2 border-b border-edge bg-surface-1 text-[10px] text-ink-faint">
        <span className="truncate border-r border-edge px-3 py-1.5 font-mono" title={request.ref}>
          {request.ref}
        </span>
        <span className="px-3 py-1.5">worktree</span>
      </div>
      {state.notes.length > 0 ? (
        <div className="border-b border-warn/30 bg-warn/10 px-3 py-1 text-[11px] text-warn">
          {state.notes.join(" ")}
        </div>
      ) : null}
      <div className="min-h-0 flex-1">
        <DiffEditor
          original={state.original}
          modified={state.modified}
          originalModelPath={paths.original}
          modifiedModelPath={paths.modified}
          theme="crystal-dark"
          loading={<Spinner />}
          options={{
            readOnly: true,
            originalEditable: false,
            renderSideBySide: true,
            fontSize: 13,
            fontFamily: "Cascadia Code, JetBrains Mono, Consolas, monospace",
            fontLigatures: true,
            minimap: { enabled: true, renderCharacters: false },
            smoothScrolling: true,
            padding: { top: 10 },
            scrollBeyondLastLine: false,
            renderWhitespace: "selection",
            automaticLayout: true,
          }}
        />
      </div>
    </div>
  );
}

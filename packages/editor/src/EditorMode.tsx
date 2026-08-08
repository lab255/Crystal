import Editor, { type OnMount } from "@monaco-editor/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Circle, Code2, GitCompareArrows, X } from "lucide-react";
import { useCrystal, useNav, useNavUpdate } from "@crystal/client";
import { Button, EmptyState, Kbd, Spinner, cn } from "@crystal/ui";
import {
  bufferFromRead,
  canCloseBuffer,
  canSaveBuffer,
  hasDirtyBuffers,
  isDirty,
  isWriteConflict,
  reduceBuffers,
  sha256Text,
  shouldCloseFromShortcut,
  writeRequestFor,
  type EditorBuffer,
} from "./editor-state.js";
import { FileTree } from "./FileTree.js";
import { QuickOpen } from "./QuickOpen.js";
import { DiffView } from "./DiffView.js";
import {
  OPEN_DIFF_EVENT,
  consumePendingDiffRequest,
  shapeDiffRequest,
  type OpenDiffRequest,
} from "./diff-view.js";
import { applyKeymap, KEYMAP_LABELS, type KeymapHandle, type KeymapProfile } from "./keymaps.js";
import { setupMonaco } from "./monaco-setup.js";

setupMonaco();

const KEYMAP_STORAGE_KEY = "crystal.editor.keymap";

function loadKeymap(): KeymapProfile {
  try {
    const v = localStorage.getItem(KEYMAP_STORAGE_KEY);
    if (v === "vscode" || v === "intellij" || v === "vim") return v;
  } catch {
    /* SSR / privacy mode */
  }
  return "vscode";
}

function isVisible(element: HTMLElement | null): boolean {
  if (!element) return false;
  if (typeof element.checkVisibility === "function") return element.checkVisibility();
  return element.offsetParent !== null;
}

export function EditorMode() {
  const { client } = useCrystal();
  const [files, setFiles] = useState<EditorBuffer[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [quickOpen, setQuickOpen] = useState(false);
  const [keymap, setKeymap] = useState<KeymapProfile>(loadKeymap);
  const [loadingFile, setLoadingFile] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [diffTab, setDiffTab] = useState<OpenDiffRequest | null>(null);
  const [diffActive, setDiffActive] = useState(false);

  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const editorRootRef = useRef<HTMLDivElement>(null);
  const keymapHandle = useRef<KeymapHandle | null>(null);
  const keymapProfileRef = useRef(keymap);
  keymapProfileRef.current = keymap;
  const vimStatusRef = useRef<HTMLDivElement>(null);

  const filesRef = useRef(files);
  filesRef.current = files;
  const activeRef = useRef(activePath);
  activeRef.current = activePath;
  const diffActiveRef = useRef(diffActive);
  diffActiveRef.current = diffActive;

  const active = files.find((f) => f.path === activePath) ?? null;

  // A requested target line survives the async open + Monaco model swap; the
  // reveal effect below fires once the right file is active.
  const pendingRevealRef = useRef<{ path: string; line: number } | null>(null);
  const tryReveal = useCallback(() => {
    const pending = pendingRevealRef.current;
    const editor = editorRef.current;
    if (!pending || !editor || activeRef.current !== pending.path) return;
    pendingRevealRef.current = null;
    // After the model swap settles — revealing the old model scrolls nothing.
    requestAnimationFrame(() => {
      editor.revealLineInCenter(pending.line);
      editor.setPosition({ lineNumber: pending.line, column: 1 });
      editor.focus();
    });
  }, []);

  const openFile = useCallback(
    async (path: string, line?: number | null) => {
      if (typeof line === "number" && line > 0) pendingRevealRef.current = { path, line };
      const existing = filesRef.current.find((f) => f.path === path);
      if (existing) {
        setActivePath(path);
        diffActiveRef.current = false;
        setDiffActive(false);
        activeRef.current = path;
        tryReveal();
        return true;
      }
      setLoadingFile(true);
      setError(null);
      try {
        const read = await client.request("fs.read", { path });
        // Re-check inside the updater: a concurrent openFile for the same path
        // (deep-link effect + open-file event) passes the guard above before
        // either fetch lands, and must not append a second tab.
        setFiles((fs) =>
          fs.some((f) => f.path === path)
            ? fs
            : [...fs, bufferFromRead(path, read)],
        );
        setActivePath(path);
        diffActiveRef.current = false;
        setDiffActive(false);
        return true;
      } catch (err) {
        setError((err as Error).message);
        return false;
      } finally {
        setLoadingFile(false);
      }
    },
    [client, tryReveal],
  );

  useEffect(() => {
    tryReveal();
  }, [activePath, files, tryReveal]);

  const saveFile = useCallback(
    async (path: string, overwrite = false) => {
      const file = filesRef.current.find((candidate) => candidate.path === path);
      if (!file || !canSaveBuffer(file)) return;
      const request = writeRequestFor(file, overwrite);
      const content = request.content;
      setError(null);
      try {
        const sha = await sha256Text(content);
        await client.request("fs.write", request);
        setFiles((fs) =>
          reduceBuffers(fs, { type: "save-succeeded", path, content, sha }),
        );
      } catch (err) {
        if (isWriteConflict(err)) {
          setFiles((fs) => reduceBuffers(fs, { type: "save-conflicted", path }));
        } else {
          setError((err as Error).message);
        }
      }
    },
    [client],
  );

  const saveActive = useCallback(() => {
    const path = activeRef.current;
    if (path) void saveFile(path);
  }, [saveFile]);

  const reloadFromDisk = useCallback(
    async (path: string, expectedSha?: string) => {
      setError(null);
      try {
        const read = await client.request("fs.read", { path });
        setFiles((fs) =>
          reduceBuffers(
            fs,
            expectedSha === undefined
              ? { type: "reload-discarded", path, read }
              : { type: "disk-reloaded", path, expectedSha, read },
          ),
        );
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [client],
  );

  const closeFile = useCallback((path: string): void => {
    const file = filesRef.current.find((candidate) => candidate.path === path);
    if (!file || !canCloseBuffer(file, (message) => window.confirm(message))) return;
    setFiles((fs) => {
      const idx = fs.findIndex((candidate) => candidate.path === path);
      const next = fs.filter((candidate) => candidate.path !== path);
      if (activeRef.current === path) {
        const nextPath = next[Math.min(idx, next.length - 1)]?.path ?? null;
        activeRef.current = nextPath;
        setActivePath(nextPath);
      }
      return next;
    });
  }, []);

  const closeDiff = useCallback(() => {
    diffActiveRef.current = false;
    setDiffActive(false);
    setDiffTab(null);
  }, []);

  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!hasDirtyBuffers(filesRef.current)) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  useEffect(() => {
    return client.events.on("fs.changed", ({ ws, paths }) => {
      if (client.scope && ws !== client.scope) return;
      const changedPaths = new Set(paths);
      const changedFiles = filesRef.current.filter((file) => changedPaths.has(file.path));
      if (changedFiles.length === 0) return;

      setFiles((fs) => {
        let next = fs;
        for (const file of changedFiles) {
          next = reduceBuffers(next, { type: "disk-changed", path: file.path });
        }
        return next;
      });
      for (const file of changedFiles) void reloadFromDisk(file.path, file.sha);
    });
  }, [client, reloadFromDisk]);

  // Deep links: the URL carries the active file. Opening from the URL only
  // reacts to nav changes (not activePath) so a tab click isn't fought by a
  // momentarily stale link; the write-back below keeps the two converged.
  const nav = useNavUpdate();
  const navFile = useNav((l) => l.code?.file) ?? null;
  useEffect(() => {
    if (!navFile || navFile === activeRef.current) return;
    void openFile(navFile).then((ok) => {
      // A dead link (deleted file, another workspace's path) must not stay in
      // the URL — it would re-fire the failing read on every remount.
      if (!ok && activeRef.current !== navFile) nav({ code: { file: null } });
    });
  }, [navFile, openFile, nav]);
  const hadFileRef = useRef(false);
  useEffect(() => {
    if (activePath) {
      hadFileRef.current = true;
      nav({ code: { file: activePath } });
    } else if (hadFileRef.current) {
      // Only clear once a file was actually open — a null activePath on mount
      // must not wipe a deep-linked file that is still being fetched.
      nav({ code: { file: null } });
    }
  }, [activePath, nav]);

  // Global shortcuts: quick-open. Also honor cross-mode open-file requests
  // (dispatched by the code map's "Open in editor").
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "p" && !e.shiftKey) {
        e.preventDefault();
        setQuickOpen(true);
      }
      // The desktop menu deliberately leaves Cmd+W unbound (no native Close
      // Window item), so the webview owns it: close the active editor tab.
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "w" && !e.shiftKey && !e.altKey) {
        if (diffActiveRef.current) {
          if (!isVisible(editorRootRef.current)) return;
          e.preventDefault();
          closeDiff();
          return;
        }
        if (
          !shouldCloseFromShortcut({
            visible: isVisible(editorRootRef.current),
            keymap: keymapProfileRef.current,
            editorFocused: editorRef.current?.hasTextFocus() ?? false,
          })
        ) {
          return;
        }
        e.preventDefault();
        if (activeRef.current) closeFile(activeRef.current);
      }
    };
    const consumePending = () => {
      try {
        const pending = sessionStorage.getItem("crystal.pendingOpenFile");
        if (pending) {
          sessionStorage.removeItem("crystal.pendingOpenFile");
          // JSON `{path, line, ws}` today; bare paths from older sessions still open.
          try {
            const parsed = JSON.parse(pending) as {
              path?: string;
              line?: number | null;
              ws?: string;
            };
            // A request parked before a workspace switch belongs to the old
            // root — dropping it beats reading the path against the wrong one.
            if (parsed?.ws && client.scope && parsed.ws !== client.scope) return false;
            if (typeof parsed?.path === "string") void openFile(parsed.path, parsed.line);
            else void openFile(pending);
          } catch {
            void openFile(pending);
          }
          return true;
        }
      } catch {
        /* storage unavailable */
      }
      return false;
    };
    const onOpenRequest = (e: Event) => {
      const detail = (e as CustomEvent<{ path?: string; line?: number }>).detail;
      consumePending();
      if (typeof detail?.path === "string") void openFile(detail.path, detail.line);
    };
    consumePending(); // opened lazily after a request fired
    window.addEventListener("keydown", onKey);
    window.addEventListener("crystal:open-file", onOpenRequest);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("crystal:open-file", onOpenRequest);
    };
  }, [openFile, closeFile, closeDiff, client]);

  useEffect(() => {
    const showDiff = (request: OpenDiffRequest) => {
      setDiffTab(request);
      diffActiveRef.current = true;
      setDiffActive(true);
    };
    const pending = consumePendingDiffRequest(client.scope);
    if (pending) showDiff(pending);
    const onOpenDiff = (event: Event) => {
      const request = shapeDiffRequest((event as CustomEvent<unknown>).detail);
      // A live delivery owns the request; clear its lazy-mount handoff so a
      // later editor remount cannot reopen a stale diff.
      consumePendingDiffRequest(client.scope);
      if (request) showDiff(request);
    };
    window.addEventListener(OPEN_DIFF_EVENT, onOpenDiff);
    return () => window.removeEventListener(OPEN_DIFF_EVENT, onOpenDiff);
  }, [client]);

  const applyProfile = useCallback(
    (profile: KeymapProfile) => {
      keymapHandle.current?.dispose();
      keymapHandle.current = null;
      const editor = editorRef.current;
      if (editor) {
        keymapHandle.current = applyKeymap(editor, profile, {
          onSave: () => void saveActive(),
          statusBar: vimStatusRef.current,
        });
      }
    },
    [saveActive],
  );

  const onMount: OnMount = useCallback(
    (editor) => {
      editorRef.current = editor;
      applyProfile(keymap);
      tryReveal();
    },
    [applyProfile, keymap, tryReveal],
  );

  function switchKeymap(profile: KeymapProfile): void {
    keymapProfileRef.current = profile;
    setKeymap(profile);
    try {
      localStorage.setItem(KEYMAP_STORAGE_KEY, profile);
    } catch {
      /* ignore */
    }
    applyProfile(profile);
  }

  useEffect(() => () => keymapHandle.current?.dispose(), []);

  return (
    <div ref={editorRootRef} className="flex h-full min-h-0">
      <aside className="w-56 shrink-0 border-r border-edge bg-surface-1">
        <FileTree activePath={activePath} onOpenFile={(p) => void openFile(p)} />
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        {files.length > 0 || diffTab ? (
          <div className="flex items-center border-b border-edge bg-surface-1">
            <div className="flex min-w-0 flex-1 items-center overflow-x-auto">
              {files.map((file) => {
                const dirty = isDirty(file);
                const name = file.path.split("/").pop();
                return (
                  <div
                    key={file.path}
                    className={cn(
                      "group flex shrink-0 cursor-pointer items-center gap-1.5 border-r border-edge px-3 py-1.5 text-xs",
                      !diffActive && file.path === activePath
                        ? "bg-surface-0 text-ink"
                        : "text-ink-muted hover:bg-surface-2",
                    )}
                    onClick={() => {
                      setActivePath(file.path);
                      diffActiveRef.current = false;
                      setDiffActive(false);
                    }}
                    title={file.path}
                  >
                    {dirty ? <Circle className="h-2 w-2 fill-crystal-400 text-crystal-400" /> : null}
                    <span>{name}</span>
                    <button
                      type="button"
                      aria-label={`Close ${name}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        closeFile(file.path);
                      }}
                      className="rounded p-0.5 opacity-0 transition-opacity hover:bg-surface-3 group-hover:opacity-100"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                );
              })}
              {diffTab ? (
                <div
                  className={cn(
                    "group flex shrink-0 cursor-pointer items-center gap-1.5 border-r border-edge px-3 py-1.5 text-xs",
                    diffActive
                      ? "bg-surface-0 text-ink"
                      : "text-ink-muted hover:bg-surface-2",
                  )}
                  onClick={() => {
                    diffActiveRef.current = true;
                    setDiffActive(true);
                  }}
                  title={`${diffTab.path} vs ${diffTab.ref}`}
                >
                  <GitCompareArrows className="h-3 w-3 text-crystal-300" />
                  <span className="max-w-80 truncate">
                    {diffTab.path} ⇄ {diffTab.ref}
                  </span>
                  <button
                    type="button"
                    aria-label={`Close diff ${diffTab.path} vs ${diffTab.ref}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      closeDiff();
                    }}
                    className="rounded p-0.5 opacity-0 transition-opacity hover:bg-surface-3 group-hover:opacity-100"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ) : null}
            </div>
            {!diffActive ? (
              <div className="flex shrink-0 items-center gap-0.5 px-2">
                {(Object.keys(KEYMAP_LABELS) as KeymapProfile[]).map((profile) => (
                  <Button
                    key={profile}
                    variant="ghost"
                    size="xs"
                    className={cn(keymap === profile && "bg-surface-3 text-ink")}
                    onClick={() => switchKeymap(profile)}
                  >
                    {KEYMAP_LABELS[profile]}
                  </Button>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="relative min-h-0 flex-1">
          {diffActive && diffTab ? (
            <DiffView request={diffTab} />
          ) : active ? (
            <div className="flex h-full min-h-0 flex-col">
              {active.truncated ? (
                <div className="border-b border-warn/30 bg-warn/10 px-3 py-1 text-[11px] text-warn">
                  Large file — showing the first 2 MB. Editing and saving are disabled to protect
                  the rest of the file.
                </div>
              ) : null}
              {active.conflicted ? (
                <div className="flex items-center gap-2 border-b border-danger/30 bg-danger/10 px-3 py-1 text-[11px] text-danger">
                  <span className="min-w-0 flex-1">
                    This file changed on disk. Your edits were kept and have not overwritten it.
                  </span>
                  <Button
                    variant="secondary"
                    size="xs"
                    onClick={() => void reloadFromDisk(active.path)}
                  >
                    Reload from disk (discard my edits)
                  </Button>
                  <Button
                    variant="danger"
                    size="xs"
                    onClick={() => void saveFile(active.path, true)}
                  >
                    Save anyway (overwrite)
                  </Button>
                </div>
              ) : null}
              <div className="min-h-0 flex-1">
                <Editor
                  path={active.path}
                  value={active.content}
                  onChange={(value) => {
                    setFiles((fs) =>
                      reduceBuffers(fs, {
                        type: "edit",
                        path: active.path,
                        content: value ?? "",
                      }),
                    );
                  }}
                  onMount={onMount}
                  theme="crystal-dark"
                  keepCurrentModel
                  loading={<Spinner />}
                  options={{
                    fontSize: 13,
                    fontFamily: "Cascadia Code, JetBrains Mono, Consolas, monospace",
                    fontLigatures: true,
                    minimap: { enabled: true, renderCharacters: false },
                    smoothScrolling: true,
                    cursorBlinking: "smooth",
                    padding: { top: 10 },
                    scrollBeyondLastLine: false,
                    renderWhitespace: "selection",
                    bracketPairColorization: { enabled: true },
                    automaticLayout: true,
                    readOnly: active.truncated,
                    readOnlyMessage: {
                      value:
                        "Editing is disabled because only the first 2 MB of this file was loaded.",
                    },
                  }}
                />
              </div>
            </div>
          ) : loadingFile ? (
            <div className="flex h-full items-center justify-center">
              <Spinner />
            </div>
          ) : (
            <EmptyState icon={Code2} title="No file open">
              Pick a file from the tree, or press <Kbd>Ctrl</Kbd> <Kbd>P</Kbd> to jump to one.
              Keybindings: VS Code, IntelliJ or Vim — switch in the tab bar.
            </EmptyState>
          )}
          {error ? (
            <div className="absolute bottom-8 left-1/2 z-10 -translate-x-1/2 rounded-lg border border-danger/40 bg-surface-2 px-3 py-1.5 text-xs text-danger shadow-lg">
              {error}
            </div>
          ) : null}
          <div
            ref={vimStatusRef}
            className={cn(
              "absolute bottom-0 left-0 right-0 z-10 border-t border-edge bg-surface-1 px-2 py-0.5 font-mono text-[11px] text-ink-muted empty:hidden",
              (diffActive || keymap !== "vim") && "hidden",
            )}
          />
        </div>
      </main>

      <QuickOpen
        open={quickOpen}
        onOpenChange={setQuickOpen}
        onPick={(path) => {
          nav({ mode: "code", code: { file: path } });
          void openFile(path);
        }}
      />
    </div>
  );
}

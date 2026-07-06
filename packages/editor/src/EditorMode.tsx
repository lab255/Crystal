import Editor, { type OnMount } from "@monaco-editor/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Circle, Code2, X } from "lucide-react";
import { useCrystal, useNav, useNavUpdate } from "@crystal/client";
import { Button, EmptyState, Kbd, Spinner, cn } from "@crystal/ui";
import { FileTree } from "./FileTree.js";
import { QuickOpen } from "./QuickOpen.js";
import { applyKeymap, KEYMAP_LABELS, type KeymapHandle, type KeymapProfile } from "./keymaps.js";
import { setupMonaco } from "./monaco-setup.js";

setupMonaco();

interface OpenFile {
  path: string;
  content: string;
  savedContent: string;
  truncated: boolean;
}

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

export function EditorMode() {
  const { client } = useCrystal();
  const [files, setFiles] = useState<OpenFile[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [quickOpen, setQuickOpen] = useState(false);
  const [keymap, setKeymap] = useState<KeymapProfile>(loadKeymap);
  const [loadingFile, setLoadingFile] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const keymapHandle = useRef<KeymapHandle | null>(null);
  const vimStatusRef = useRef<HTMLDivElement>(null);

  const filesRef = useRef(files);
  filesRef.current = files;
  const activeRef = useRef(activePath);
  activeRef.current = activePath;

  const active = files.find((f) => f.path === activePath) ?? null;

  const openFile = useCallback(
    async (path: string) => {
      const existing = filesRef.current.find((f) => f.path === path);
      if (existing) {
        setActivePath(path);
        return;
      }
      setLoadingFile(true);
      setError(null);
      try {
        const { content, truncated } = await client.request("fs.read", { path });
        setFiles((fs) => [...fs, { path, content, savedContent: content, truncated }]);
        setActivePath(path);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setLoadingFile(false);
      }
    },
    [client],
  );

  const saveActive = useCallback(async () => {
    const path = activeRef.current;
    const file = filesRef.current.find((f) => f.path === path);
    if (!file || !path) return;
    try {
      await client.request("fs.write", { path, content: file.content });
      setFiles((fs) =>
        fs.map((f) => (f.path === path ? { ...f, savedContent: f.content } : f)),
      );
    } catch (err) {
      setError((err as Error).message);
    }
  }, [client]);

  function closeFile(path: string): void {
    setFiles((fs) => {
      const idx = fs.findIndex((f) => f.path === path);
      const next = fs.filter((f) => f.path !== path);
      if (activeRef.current === path) {
        setActivePath(next[Math.min(idx, next.length - 1)]?.path ?? null);
      }
      return next;
    });
  }

  // Deep links: the URL carries the active file. Opening from the URL only
  // reacts to nav changes (not activePath) so a tab click isn't fought by a
  // momentarily stale link; the write-back below keeps the two converged.
  const nav = useNavUpdate();
  const navFile = useNav((l) => l.code?.file) ?? null;
  useEffect(() => {
    if (navFile && navFile !== activeRef.current) void openFile(navFile);
  }, [navFile, openFile]);
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
    };
    const consumePending = () => {
      try {
        const pending = sessionStorage.getItem("crystal.pendingOpenFile");
        if (pending) {
          sessionStorage.removeItem("crystal.pendingOpenFile");
          void openFile(pending);
          return true;
        }
      } catch {
        /* storage unavailable */
      }
      return false;
    };
    const onOpenRequest = (e: Event) => {
      const path = (e as CustomEvent<{ path?: string }>).detail?.path;
      consumePending();
      if (typeof path === "string") void openFile(path);
    };
    consumePending(); // opened lazily after a request fired
    window.addEventListener("keydown", onKey);
    window.addEventListener("crystal:open-file", onOpenRequest);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("crystal:open-file", onOpenRequest);
    };
  }, [openFile]);

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
    },
    [applyProfile, keymap],
  );

  function switchKeymap(profile: KeymapProfile): void {
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
    <div className="flex h-full min-h-0">
      <aside className="w-56 shrink-0 border-r border-edge bg-surface-1">
        <FileTree activePath={activePath} onOpenFile={(p) => void openFile(p)} />
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        {files.length > 0 ? (
          <div className="flex items-center border-b border-edge bg-surface-1">
            <div className="flex min-w-0 flex-1 items-center overflow-x-auto">
              {files.map((file) => {
                const dirty = file.content !== file.savedContent;
                const name = file.path.split("/").pop();
                return (
                  <div
                    key={file.path}
                    className={cn(
                      "group flex shrink-0 cursor-pointer items-center gap-1.5 border-r border-edge px-3 py-1.5 text-xs",
                      file.path === activePath
                        ? "bg-surface-0 text-ink"
                        : "text-ink-muted hover:bg-surface-2",
                    )}
                    onClick={() => setActivePath(file.path)}
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
            </div>
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
          </div>
        ) : null}

        <div className="relative min-h-0 flex-1">
          {active ? (
            <>
              {active.truncated ? (
                <div className="border-b border-warn/30 bg-warn/10 px-3 py-1 text-[11px] text-warn">
                  Large file — showing the first 2 MB (read-only view recommended).
                </div>
              ) : null}
              <Editor
                path={active.path}
                value={active.content}
                onChange={(value) => {
                  const v = value ?? "";
                  setFiles((fs) =>
                    fs.map((f) => (f.path === active.path ? { ...f, content: v } : f)),
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
                }}
              />
            </>
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
              keymap !== "vim" && "hidden",
            )}
          />
        </div>
      </main>

      <QuickOpen open={quickOpen} onOpenChange={setQuickOpen} onPick={(p) => void openFile(p)} />
    </div>
  );
}

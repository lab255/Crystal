import "@xyflow/react/dist/style.css";
import "./architect.css";
import { useCallback, useEffect, useState } from "react";
import {
  Boxes,
  Check,
  CloudUpload,
  FolderGit2,
  MoreHorizontal,
  PencilRuler,
  Plus,
  Trash2,
} from "lucide-react";
import type { ArchitectureGraph, CodeMapSummary } from "@crystal/core";
import { useConnectionState, useCrystal, useWorkspace, useWorkspaces } from "@crystal/client";
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  EmptyState,
  Input,
  Spinner,
  Tooltip,
  cn,
} from "@crystal/ui";
import { ArchitectCanvas } from "./ArchitectCanvas.js";
import { CodeMapView } from "./codemap/CodeMapView.js";

const EMPTY_ARCHITECTURES: never[] = [];

type ArchitectView = "diagrams" | "codemap";

export function ArchitectMode() {
  const [view, setView] = useState<ArchitectView>("diagrams");

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-2 border-b border-edge bg-surface-1 px-3 py-1.5">
        <span className="text-[13px] font-semibold text-ink">Architecture</span>
        <div className="ml-auto flex items-center gap-0.5 rounded-lg bg-surface-2 p-0.5">
          <button
            type="button"
            onClick={() => setView("diagrams")}
            className={cn(
              "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
              view === "diagrams" ? "bg-surface-3 text-ink" : "text-ink-muted hover:text-ink",
            )}
          >
            <PencilRuler className="h-3.5 w-3.5" /> Diagrams
          </button>
          <button
            type="button"
            onClick={() => setView("codemap")}
            className={cn(
              "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
              view === "codemap" ? "bg-surface-3 text-ink" : "text-ink-muted hover:text-ink",
            )}
          >
            <FolderGit2 className="h-3.5 w-3.5" /> Code map
            <span className="rounded-full bg-ok/15 px-1.5 text-[9px] text-ok">live</span>
          </button>
        </div>
      </header>
      <div className="min-h-0 flex-1">{view === "diagrams" ? <DiagramsView /> : <CodeMapView />}</div>
    </div>
  );
}

function DiagramsView() {
  const architectures = useWorkspace((s) => s.info?.architectures ?? EMPTY_ARCHITECTURES);
  const loading = useWorkspace((s) => s.loading && !s.info);
  const pendingSaves = useWorkspace((s) => s.pendingSaves);
  const updateArchitecture = useWorkspace((s) => s.updateArchitecture);
  const createArchitecture = useWorkspace((s) => s.createArchitecture);
  const deleteArchitecture = useWorkspace((s) => s.deleteArchitecture);

  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");

  // Live code map for the diagram overlay — kept fresh by codemap.changed.
  const { client } = useCrystal();
  const connection = useConnectionState();
  const activeWs = useWorkspaces((s) => s.activeId);
  const [overlayOn, setOverlayOn] = useState(false);
  const [codeSummary, setCodeSummary] = useState<CodeMapSummary | null>(null);

  const fetchSummary = useCallback(async () => {
    try {
      setCodeSummary(await client.request("codemap.get", {}));
    } catch {
      // Bridge closed or workspace has no analyzable code; overlay stays off.
    }
  }, [client]);

  useEffect(() => {
    if (connection === "open") void fetchSummary();
  }, [fetchSummary, connection]);
  useEffect(
    () =>
      client.events.on("codemap.changed", ({ ws }) => {
        if (!activeWs || ws === activeWs) void fetchSummary();
      }),
    [client, fetchSummary, activeWs],
  );

  const selected =
    architectures.find((a) => a.path === selectedPath) ?? architectures[0] ?? null;

  useEffect(() => {
    if (selected && selected.path !== selectedPath) setSelectedPath(selected.path);
  }, [selected?.path]);

  const saving = Object.keys(pendingSaves).length > 0;

  async function handleCreate() {
    const name = newName.trim();
    if (!name) return;
    const created = await createArchitecture(name);
    setSelectedPath(created.path);
    setNewName("");
    setCreateOpen(false);
  }

  return (
    <div className="flex h-full min-h-0">
      <aside className="flex w-56 shrink-0 flex-col border-r border-edge bg-surface-1">
        <div className="flex items-center justify-between px-3 py-2.5">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
            Architectures
          </span>
          <div className="flex items-center gap-1">
            <Tooltip content={saving ? "Saving…" : "All changes saved to .crystal/"}>
              <span className="text-ink-faint">
                {saving ? (
                  <CloudUpload className="h-3.5 w-3.5 animate-pulse text-info" />
                ) : (
                  <Check className="h-3.5 w-3.5 text-ok/70" />
                )}
              </span>
            </Tooltip>
            <Tooltip content="New architecture">
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => setCreateOpen(true)}
                aria-label="New architecture"
              >
                <Plus className="h-3.5 w-3.5" />
              </Button>
            </Tooltip>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
          {architectures.map((a) => (
            <div
              key={a.path}
              className={cn(
                "group flex items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] cursor-pointer",
                selected?.path === a.path
                  ? "bg-crystal-500/15 text-ink"
                  : "text-ink-muted hover:bg-surface-2 hover:text-ink",
              )}
              onClick={() => setSelectedPath(a.path)}
            >
              <Boxes className="h-3.5 w-3.5 shrink-0 opacity-70" />
              <span className="min-w-0 flex-1 truncate">{a.graph.name}</span>
              <span className="text-[10px] text-ink-faint">{a.graph.nodes.length}</span>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100"
                    onClick={(e) => e.stopPropagation()}
                    aria-label="Architecture actions"
                  >
                    <MoreHorizontal className="h-3.5 w-3.5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  <DropdownMenuItem
                    className="text-danger"
                    onSelect={() => void deleteArchitecture(a.path)}
                  >
                    <Trash2 className="h-3.5 w-3.5" /> Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          ))}
        </div>
      </aside>

      <main className="min-w-0 flex-1">
        {loading ? (
          <div className="flex h-full items-center justify-center">
            <Spinner />
          </div>
        ) : selected ? (
          <ArchitectCanvas
            graph={selected.graph}
            onChange={(graph: ArchitectureGraph) => updateArchitecture(selected.path, graph)}
            codeSummary={codeSummary}
            overlayOn={overlayOn}
            onToggleOverlay={setOverlayOn}
          />
        ) : (
          <EmptyState
            icon={Boxes}
            title="No architectures yet"
            action={
              <Button variant="primary" size="sm" onClick={() => setCreateOpen(true)}>
                <Plus className="h-3.5 w-3.5" /> New architecture
              </Button>
            }
          >
            Model your system as nested groups of services, stores and flows. Diagrams are
            saved to <code className="text-ink">.crystal/architecture/</code> in your repo.
          </EmptyState>
        )}
      </main>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent
          title="New architecture"
          description="Saved as a versionable file in .crystal/architecture/"
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void handleCreate();
            }}
            className="space-y-3"
          >
            <Input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="e.g. Payments platform"
            />
            <div className="flex justify-end gap-2">
              <DialogClose asChild>
                <Button variant="ghost" size="sm">
                  Cancel
                </Button>
              </DialogClose>
              <Button type="submit" variant="primary" size="sm" disabled={!newName.trim()}>
                Create
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

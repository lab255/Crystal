import { useEffect, useMemo, useState } from "react";
import {
  AppWindow,
  BookOpenText,
  Bot,
  Boxes,
  Coins,
  Component,
  Database,
  FlaskConical,
  Folder,
  FolderPlus,
  Globe2,
  History,
  KanbanSquare,
  Layers,
  Network,
  PencilRuler,
  Plus,
  Target,
  Sparkles,
  TerminalSquare,
  Umbrella,
  Webhook,
  type LucideIcon,
} from "lucide-react";
import { useNavUpdate, useWorkspace, useWorkspaces } from "@crystal/client";
import { CommandList, Dialog, DialogContent, Kbd } from "@crystal/ui";
import { CRYSTAL_MODES, MODE_ICONS, MODE_LABELS, type CrystalMode } from "./modes.js";

export interface Command {
  id: string;
  title: string;
  icon: LucideIcon;
  hint?: string;
  run: () => void;
}

// zustand v5: selectors must return stable references — module-level constants.
const EMPTY_ARCHITECTURES: never[] = [];
const EMPTY_PROJECTS: never[] = [];

export function CommandPalette({
  open,
  onOpenChange,
  onSwitchMode,
  onSelectWorkspace,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSwitchMode: (mode: CrystalMode) => void;
  onSelectWorkspace: (id: string) => void;
}) {
  const createArchitecture = useWorkspace((s) => s.createArchitecture);
  const createProject = useWorkspace((s) => s.createProject);
  const architectures = useWorkspace((s) => s.info?.architectures ?? EMPTY_ARCHITECTURES);
  const projects = useWorkspace((s) => s.info?.projects ?? EMPTY_PROJECTS);
  const nav = useNavUpdate();
  const workspaces = useWorkspaces((s) => s.workspaces);
  const recents = useWorkspaces((s) => s.recents);
  const activeWsId = useWorkspaces((s) => s.activeId);
  const openWorkspace = useWorkspaces((s) => s.openWorkspace);
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (open) setQuery("");
  }, [open]);

  const commands: Command[] = useMemo(() => {
    const openRoots = new Set(workspaces.map((w) => w.root));
    return [
      // Workspaces are the top level: switching and reopening come first.
      ...workspaces
        .map((w, i) => ({ w, i }))
        .filter(({ w }) => w.id !== activeWsId)
        .map(({ w, i }) => ({
          id: `ws.switch.${w.id}`,
          title: `Switch to workspace: ${w.name}`,
          icon: Folder,
          hint: i < 9 ? `Ctrl+Alt+${i + 1}` : undefined,
          run: () => onSelectWorkspace(w.id),
        })),
      ...recents
        .filter((r) => !openRoots.has(r.root) && !r.missing)
        .map((r) => ({
          id: `ws.reopen.${r.root}`,
          title: `Reopen workspace: ${r.name}`,
          icon: History,
          run: () => void openWorkspace(r.root),
        })),
      {
        id: "ws.open",
        title: "Open workspace…",
        icon: FolderPlus,
        run: () => window.dispatchEvent(new CustomEvent("crystal:open-workspace")),
      },
      // One entry per mode, straight from the registry — the rail derives its
      // Ctrl+N shortcuts the same way, so inserting a mode can never leave the
      // palette advertising the wrong key.
      ...CRYSTAL_MODES.map((m, i) => ({
        id: `mode.${m}`,
        title: `Go to ${MODE_LABELS[m]}`,
        icon: MODE_ICONS[m],
        hint: `Ctrl+${i + 1}`,
        run: () => onSwitchMode(m),
      })),
      {
        id: "view.hub.programs",
        title: "Hub: Programs across projects",
        icon: Target,
        run: () => {
          onSwitchMode("hub");
          nav({ hub: { view: "programs" } });
        },
      },
      {
        id: "view.hub.projects",
        title: "Hub: Projects and what they carry",
        icon: Boxes,
        run: () => {
          onSwitchMode("hub");
          nav({ hub: { view: "projects" } });
        },
      },
      // Views inside a mode are jump targets too — a palette hit lands on the
      // exact screen, not just the mode.
      {
        id: "view.architect.workspaces",
        title: "Architecture: Codebase map",
        icon: Layers,
        run: () => {
          onSwitchMode("architect");
          nav({ architect: { view: "codebase", codemap: { kind: "all" } } });
        },
      },
      {
        id: "view.architect.systems",
        title: "Architecture: Systems overview",
        icon: Boxes,
        run: () => {
          onSwitchMode("architect");
          nav({ architect: { view: "systems" } });
        },
      },
      ...(
        [
          ["screens", "Screens", AppWindow],
          ["components", "Components", Component],
          ["stories", "Stories", BookOpenText],
          ["apis", "API explorer", Webhook],
          ["schemas", "Data schemas", Database],
        ] as const
      ).map(([view, label, icon]) => ({
        id: `view.surfaces.${view}`,
        title: `Surfaces: ${label}`,
        icon: icon as LucideIcon,
        run: () => {
          onSwitchMode("surfaces");
          nav({ surfaces: { view } });
        },
      })),
      {
        id: "view.quality.tests",
        title: "Quality: Test runner",
        icon: FlaskConical,
        run: () => {
          onSwitchMode("quality");
          nav({ quality: { view: "tests" } });
        },
      },
      {
        id: "view.quality.coverage",
        title: "Quality: Coverage",
        icon: Umbrella,
        run: () => {
          onSwitchMode("quality");
          nav({ quality: { view: "coverage" } });
        },
      },
      {
        id: "view.architect.code",
        title: "Architecture: Code diagrams",
        icon: PencilRuler,
        run: () => {
          onSwitchMode("architect");
          nav({ architect: { view: "diagrams" } });
        },
      },
      {
        id: "view.architect.infra",
        title: "Architecture: Infrastructure",
        icon: Globe2,
        run: () => {
          onSwitchMode("architect");
          nav({ architect: { view: "infra" } });
        },
      },
      ...(["board", "workflows", "runs", "agents", "costs"] as const).map((tab) => ({
        id: `view.orchestrate.${tab}`,
        title: `Orchestrate: ${tab === "costs" ? "Cost attribution" : `${tab[0]!.toUpperCase()}${tab.slice(1)}`}`,
        icon:
          tab === "board"
            ? KanbanSquare
            : tab === "runs"
              ? History
              : tab === "workflows"
                ? Network
                : tab === "costs"
                  ? Coins
                  : Bot,
        run: () => {
          onSwitchMode("orchestrate");
          nav({ orchestrate: { tab } });
        },
      })),
      // Documents in the active workspace: diagrams, their facets, boards.
      ...architectures.map((a) => ({
        id: `arch.open.${a.path}`,
        title: `Open diagram: ${a.graph.name}`,
        icon: PencilRuler,
        run: () => {
          onSwitchMode("architect");
          nav({ architect: { view: "diagrams", diagram: a.path, facet: null } });
        },
      })),
      ...architectures.flatMap((a) =>
        a.graph.facets.map((f) => ({
          id: `facet.${a.path}.${f.id}`,
          title: `Jump to facet: ${f.name} — ${a.graph.name}`,
          icon: Sparkles,
          run: () => {
            onSwitchMode("architect");
            nav({ architect: { view: "diagrams", diagram: a.path, facet: f.id } });
          },
        })),
      ),
      ...projects.map((p) => ({
        id: `board.open.${p.path}`,
        title: `Open board: ${p.project.name}`,
        icon: KanbanSquare,
        run: () => {
          onSwitchMode("orchestrate");
          nav({ orchestrate: { tab: "board" as const, project: p.path } });
        },
      })),
      {
        id: "terminal.new",
        title: "New terminal (active workspace)",
        icon: TerminalSquare,
        run: () => window.dispatchEvent(new CustomEvent("crystal:open-terminal", { detail: {} })),
      },
      {
        id: "terminal.agent",
        title: "New agent console (active workspace)",
        icon: Bot,
        run: () =>
          window.dispatchEvent(
            new CustomEvent("crystal:open-terminal", { detail: { kind: "agent" } }),
          ),
      },
      {
        id: "arch.new",
        title: "New architecture diagram",
        icon: Plus,
        run: () => {
          onSwitchMode("architect");
          void createArchitecture("Untitled architecture");
        },
      },
      {
        id: "project.new",
        title: "New project board",
        icon: Plus,
        run: () => {
          onSwitchMode("orchestrate");
          void createProject("Untitled project");
        },
      },
    ];
  }, [
    onSwitchMode,
    onSelectWorkspace,
    createArchitecture,
    createProject,
    architectures,
    projects,
    nav,
    workspaces,
    recents,
    activeWsId,
    openWorkspace,
  ]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter((c) => c.title.toLowerCase().includes(q));
  }, [commands, query]);

  function run(cmd: Command): void {
    onOpenChange(false);
    cmd.run();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Command palette" className="top-[30%] w-[480px]">
        {/* The shared filtered-list body (same one as quick-open). */}
        <CommandList
          query={query}
          onQueryChange={setQuery}
          items={results}
          itemKey={(cmd) => cmd.id}
          placeholder="Type a command…"
          emptyText="No commands"
          onPick={run}
          renderItem={(cmd) => {
            const Icon = cmd.icon;
            return (
              <>
                <Icon className="h-4 w-4 shrink-0 text-ink-faint" />
                <span className="flex-1">{cmd.title}</span>
                {cmd.hint ? <Kbd>{cmd.hint}</Kbd> : null}
              </>
            );
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

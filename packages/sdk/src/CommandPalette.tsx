import { useEffect, useMemo, useState } from "react";
import {
  AppWindow,
  BookmarkPlus,
  BookOpenText,
  Bot,
  Boxes,
  ChartColumn,
  CircleCheck,
  CircleDot,
  CircleHelp,
  Coins,
  Component,
  Database,
  Eye,
  FlaskConical,
  Folder,
  FolderPlus,
  GitCompareArrows,
  Globe2,
  History,
  KanbanSquare,
  Keyboard,
  Layers,
  ListTodo,
  MessagesSquare,
  Network,
  PencilRuler,
  Plus,
  Settings as SettingsIcon,
  SunMoon,
  Target,
  Sparkles,
  Share2,
  TerminalSquare,
  Telescope,
  Umbrella,
  Webhook,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import {
  TASK_ATTENTION_LABELS,
  attentionRunIds,
  compareTaskAttention,
  deriveNeedsYou,
  formatWsRef,
  groupRunsByManager,
  livenessIndex,
  liveRunIds,
  sessionDisplayStatus,
  sessionHeadline,
  sessionLatestActivity,
  taskAttention,
  type AgentRun,
  type OrchestratorTabId,
  type PendingPermission,
  type TaskAttentionGroup,
  type TaskItem,
  type Workflow,
} from "@crystal/core";
import {
  EMPTY_RUNS,
  settingsStore,
  useAgents,
  useCrystal,
  useFleet,
  useFleetConnections,
  useLens,
  useNav,
  useNavUpdate,
  usePermissions,
  useWorkspace,
  useWorkspaces,
  useWorkflows,
  wsKey,
} from "@crystal/client";
import { CommandList, Dialog, DialogContent, Kbd } from "@crystal/ui";
import {
  CAPABILITY_EVENTS,
  NEW_WORKFLOW_NAV,
  paletteCapabilities,
  type PaletteCapabilityAction,
  type PaletteCapabilityIcon,
} from "./capabilities.js";
import {
  CRYSTAL_MODES,
  MODE_ICONS,
  MODE_LABELS,
  modeShortcutDigit,
  type CrystalMode,
} from "./modes.js";
import { SHELL_SHORTCUTS, shortcutHint, workspaceShortcutHint } from "./shortcuts.js";

/** Command-palette icon per orchestrate tab (mirrors the tab strip). */
const ORCHESTRATE_TAB_ICONS: Record<OrchestratorTabId, LucideIcon> = {
  board: KanbanSquare,
  sessions: MessagesSquare,
  workflows: Network,
  runs: History,
  agents: Bot,
  costs: Coins,
  insights: ChartColumn,
};

/** Command-palette icon per attention group (see task-attention.ts). */
const TASK_ATTENTION_ICONS: Record<TaskAttentionGroup, LucideIcon> = {
  waiting: CircleHelp,
  running: Bot,
  review: Eye,
  in_progress: CircleDot,
  backlog: ListTodo,
  done: CircleCheck,
};

const CAPABILITY_ICONS: Record<PaletteCapabilityIcon, LucideIcon> = {
  review: GitCompareArrows,
  lens: Telescope,
  clear: XCircle,
  save: BookmarkPlus,
  publish: Share2,
  workspace: FolderPlus,
  workflow: Network,
  keyboard: Keyboard,
};

export interface Command {
  id: string;
  title: string;
  icon: LucideIcon;
  /** Keyboard shortcut, rendered as a keycap. */
  hint?: string;
  /** Status annotation ("Waiting on you"), rendered as muted text. */
  tag?: string;
  run: () => void;
}

/** One palette-searchable task with everything its jump needs. */
interface TaskJumpEntry {
  sid: string;
  wsId: string;
  /** Workspace name shown as a suffix; only set for non-active workspaces. */
  wsName: string | null;
  projectPath: string;
  projectName: string;
  task: TaskItem;
  group: TaskAttentionGroup;
}

// zustand v5: selectors must return stable references — module-level constants.
const EMPTY_ARCHITECTURES: never[] = [];
const EMPTY_PROJECTS: never[] = [];
const CLOSED_RUNS: AgentRun[] = [];
const CLOSED_PERMISSIONS: PendingPermission[] = [];
const CLOSED_WORKFLOWS: Workflow[] = [];
const CLOSED_MAP: Record<string, never> = {};

export function CommandPalette({
  open,
  onOpenChange,
  onSwitchMode,
  onSelectWorkspace,
  onOpenSettings,
  onOpenShortcuts,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSwitchMode: (mode: CrystalMode) => void;
  onSelectWorkspace: (id: string) => void;
  onOpenSettings?: (section?: "publish") => void;
  onOpenShortcuts?: () => void;
}) {
  const createArchitecture = useWorkspace((s) => s.createArchitecture);
  const createProject = useWorkspace((s) => s.createProject);
  const architectures = useWorkspace((s) => s.info?.architectures ?? EMPTY_ARCHITECTURES);
  const projects = useWorkspace((s) => s.info?.projects ?? EMPTY_PROJECTS);
  const nav = useNavUpdate();
  const workspaces = useWorkspaces((s) => s.workspaces);
  const recents = useWorkspaces((s) => s.recents);
  const activeWsId = useWorkspaces((s) => s.activeId);
  const activeReviewRef = useNav((l) => l.architect?.vs ?? null);
  const lensActive = useNav((l) => l.lens != null);
  const lensSpec = useLens((s) => s.spec);
  const canSaveLens = lensActive && lensSpec !== null && lensSpec.kind !== "facet";
  const openWorkspace = useWorkspaces((s) => s.openWorkspace);
  const { activeSid, client, selectWorkspace } = useCrystal();
  const connections = useFleetConnections();
  // Run stores churn on every stream event — gate the subscriptions on `open`
  // (stable constants while closed) so the mounted-but-hidden palette never
  // re-renders with the agent firehose.
  const activeRuns = useAgents((s) => (open ? s.runs : CLOSED_RUNS));
  const pendingPermissions = usePermissions((s) => (open ? s.pending : CLOSED_PERMISSIONS));
  const workflows = useWorkflows((s) => (open ? s.workflows : CLOSED_WORKFLOWS));
  const fleetRuns = useFleet((s) => (open ? s.runsByWs : CLOSED_MAP));
  const fleetRunsLoaded = useFleet((s) => (open ? s.runsLoadedByWs : CLOSED_MAP));
  const fleetProjects = useFleet((s) => (open ? s.projectsByWs : CLOSED_MAP));
  const [query, setQuery] = useState("");

  const activeNeedsYou = useMemo(
    () => deriveNeedsYou(projects, activeRuns, pendingPermissions),
    [activeRuns, pendingPermissions, projects],
  );
  const sessionEntries = useMemo(() => {
    const workflowNameOf = (id: string) => workflows.find((workflow) => workflow.id === id)?.name;
    const taskTitleOf = (id: string) => projects.flatMap((entry) => entry.project.tasks).find((task) => task.id === id)?.title;
    const namingContext = { workflowNameOf, taskTitleOf };
    const attention = attentionRunIds(activeNeedsYou);
    return groupRunsByManager([...activeRuns])
      .map((node) => ({
        node,
        headline: sessionHeadline(node, namingContext),
        status: sessionDisplayStatus(node, attention),
        activity: sessionLatestActivity(node),
      }))
      .sort((a, b) => {
        const rank = (status: typeof a.status) => status === "needs-you" ? 0 : status === "working" ? 1 : 2;
        return rank(a.status) - rank(b.status) || b.activity.localeCompare(a.activity);
      })
      .slice(0, 30);
  }, [activeNeedsYou, activeRuns, projects, workflows]);

  useEffect(() => {
    if (open) setQuery("");
  }, [open]);

  // Every task across every open workspace's boards, attention-ordered
  // (task-attention.ts) so the ones waiting on you rank first. The active
  // workspace reads its live stores; the rest come from the fleet store's
  // board snapshots.
  const taskEntries: TaskJumpEntry[] = useMemo(() => {
    const entries: TaskJumpEntry[] = [];
    if (activeWsId) {
      const live = liveRunIds(activeRuns);
      const runsById = livenessIndex(activeRuns);
      for (const p of projects) {
        for (const task of p.project.tasks) {
          entries.push({
            sid: activeSid,
            wsId: activeWsId,
            wsName: null,
            projectPath: p.path,
            projectName: p.project.name,
            task,
            group: taskAttention(task, live, runsById),
          });
        }
      }
    }
    for (const conn of connections) {
      for (const w of conn.workspaces) {
        if (conn.sid === activeSid && w.id === activeWsId) continue;
        const key = wsKey(conn.sid, w.id);
        const boards = fleetProjects[key];
        if (!boards?.length) continue;
        const workspaceRuns = fleetRuns[key] ?? EMPTY_RUNS;
        const live = liveRunIds(workspaceRuns);
        const runsById = fleetRunsLoaded[key] ? livenessIndex(workspaceRuns) : null;
        for (const p of boards) {
          for (const task of p.project.tasks) {
            entries.push({
              sid: conn.sid,
              wsId: w.id,
              wsName: w.name,
              projectPath: p.path,
              projectName: p.project.name,
              task,
              group: taskAttention(task, live, runsById),
            });
          }
        }
      }
    }
    return entries.sort(compareTaskAttention);
  }, [
    projects,
    activeRuns,
    connections,
    fleetProjects,
    fleetRuns,
    fleetRunsLoaded,
    activeSid,
    activeWsId,
  ]);

  const commands: Command[] = useMemo(() => {
    const openRoots = new Set(workspaces.map((w) => w.root));
    const runCapability = (action: PaletteCapabilityAction): void => {
      if (action === "review-ref") {
        window.dispatchEvent(new CustomEvent(CAPABILITY_EVENTS.reviewRef));
      } else if (action === "set-base-lens") {
        window.dispatchEvent(new CustomEvent(CAPABILITY_EVENTS.setBaseLens));
      } else if (action === "clear-lens") {
        window.dispatchEvent(new CustomEvent(CAPABILITY_EVENTS.clearLens));
      } else if (action === "save-lens") {
        window.dispatchEvent(new CustomEvent(CAPABILITY_EVENTS.saveLens));
      } else if (action === "publish-settings") {
        onOpenSettings?.("publish");
      } else if (action === "open-workspace") {
        window.dispatchEvent(new CustomEvent("crystal:open-workspace"));
      } else if (action === "new-workflow") {
        onSwitchMode("orchestrate");
        nav(NEW_WORKFLOW_NAV);
      } else {
        onOpenShortcuts?.();
      }
    };
    return [
      // Workspaces are the top level: switching and reopening come first.
      ...workspaces
        .map((w, i) => ({ w, i }))
        .filter(({ w }) => w.id !== activeWsId)
        .map(({ w, i }) => ({
          id: `ws.switch.${w.id}`,
          title: `Switch to workspace: ${w.name}`,
          icon: Folder,
          hint: workspaceShortcutHint(i),
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
      ...paletteCapabilities(canSaveLens).map((capability) => ({
        id: capability.id,
        title: capability.title,
        icon: CAPABILITY_ICONS[capability.icon],
        hint:
          capability.action === "keyboard-shortcuts"
            ? shortcutHint(SHELL_SHORTCUTS.cheatSheet)
            : undefined,
        run: () => runCapability(capability.action),
      })),
      {
        id: "review.base",
        title: "Review vs base branch",
        icon: GitCompareArrows,
        run: () => {
          void client
            .request("git.refs", {})
            .then((refs) => {
              const local = ["main", "master"].find((name) => refs.branches.includes(name));
              const remote = ["main", "master"]
                .map((name) => refs.remoteBranches.find((branch) => branch.endsWith(`/${name}`)))
                .find((branch): branch is string => branch != null);
              const base = local ?? remote;
              if (!base) {
                window.dispatchEvent(new CustomEvent(CAPABILITY_EVENTS.reviewRef));
                return;
              }
              onSwitchMode("architect");
              nav({ architect: { vs: base } });
            })
            .catch(() => window.dispatchEvent(new CustomEvent(CAPABILITY_EVENTS.reviewRef)));
        },
      },
      ...(activeReviewRef
        ? [
            {
              id: "review.end",
              title: "End review",
              icon: XCircle,
              run: () => nav({ architect: { vs: null } }),
            },
          ]
        : []),
      // One entry per mode, straight from the registry — the rail derives its
      // Ctrl+N shortcuts the same way, so inserting a mode can never leave the
      // palette advertising the wrong key.
      ...CRYSTAL_MODES.map((m) => ({
        id: `mode.${m}`,
        title: `Go to ${MODE_LABELS[m]}`,
        icon: MODE_ICONS[m],
        hint: `Ctrl+${modeShortcutDigit(m)}`,
        run: () => onSwitchMode(m),
      })),
      {
        id: "view.overview.chat",
        title: "Overview: Coordinator chat",
        icon: Target,
        run: () => {
          onSwitchMode("projects");
          nav({ projects: { view: "chat" } });
        },
      },
      {
        id: "view.overview.inbox",
        title: "Overview: Questions inbox",
        icon: Boxes,
        run: () => {
          onSwitchMode("projects");
          nav({ projects: { view: "inbox" } });
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
        id: "view.architect.architecture",
        title: "Architecture: Live diagram",
        icon: Boxes,
        run: () => {
          onSwitchMode("architect");
          nav({ architect: { view: "architecture" } });
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
        id: "view.architect.infra",
        title: "Architecture: Infrastructure",
        icon: Globe2,
        run: () => {
          onSwitchMode("architect");
          nav({ architect: { view: "infra" } });
        },
      },
      ...(["board", "sessions", "workflows", "runs", "agents", "costs", "insights"] as const).map((tab) => ({
        id: `view.orchestrate.${tab}`,
        title: `Orchestrate: ${tab === "costs" ? "Cost attribution" : `${tab[0]!.toUpperCase()}${tab.slice(1)}`}`,
        icon: ORCHESTRATE_TAB_ICONS[tab],
        run: () => {
          onSwitchMode("orchestrate");
          nav({ orchestrate: { tab } });
        },
      })),
      ...sessionEntries.map(({ node, headline, status }) => ({
        id: `session.${node.turns[0]!.id}`,
        title: `Session: ${headline}`,
        icon: MessagesSquare,
        tag: status === "needs-you" ? "Needs you" : status === "working" ? "Working" : undefined,
        run: () => {
          onSwitchMode("orchestrate");
          nav({ orchestrate: { tab: "sessions", run: node.run.id, sessionProject: null, sessionEpic: null } });
        },
      })),
      ...(activeNeedsYou.count > 0 ? [{
        id: "attention.first",
        title: `Needs you: ${activeNeedsYou.questions[0]?.question.text ?? (activeNeedsYou.permissions[0] ? `${activeNeedsYou.permissions[0].tool} needs permission` : activeNeedsYou.failures[0]?.prompt ?? "Agent session")}`,
        icon: CircleHelp,
        run: () => {
          const question = activeNeedsYou.questions[0];
          const runId = activeNeedsYou.permissions[0]?.runId ?? activeNeedsYou.failures[0]?.id;
          onSwitchMode("orchestrate");
          nav(question
            ? { orchestrate: { tab: "board", project: question.projectPath, task: question.taskId, run: null } }
            : { orchestrate: { tab: "sessions", run: runId, sessionProject: null, sessionEpic: null } });
        },
      }] : []),
      // Documents in the active workspace: diagrams, their facets, boards.
      ...architectures.map((a) => ({
        id: `arch.open.${a.path}`,
        title: `Open diagram: ${a.graph.name}`,
        icon: PencilRuler,
        run: () => {
          onSwitchMode("architect");
          nav({ architect: { view: "architecture", diagram: a.path, facet: null } });
        },
      })),
      ...architectures.flatMap((a) =>
        a.graph.facets.map((f) => ({
          id: `facet.${a.path}.${f.id}`,
          title: `Jump to facet: ${f.name} — ${a.graph.name}`,
          icon: Sparkles,
          run: () => {
            onSwitchMode("architect");
            // Facet only — a `diagram` param would resolve to the diagram's
            // own wrapper facet and clobber this one.
            nav({ architect: { view: "architecture", facet: f.id } });
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
      // Tasks across every open workspace — the board's list+session view
      // auto-shows the task's session, so a hit jumps straight into it.
      ...taskEntries.map((e) => ({
        id: `task.${e.sid}.${e.wsId}.${e.task.id}`,
        title: `Task: ${e.task.title} — ${e.projectName}${e.wsName ? ` · ${e.wsName}` : ""}`,
        icon: TASK_ATTENTION_ICONS[e.group],
        // Only attention-demanding states get the annotation; board columns
        // would just be noise on every row.
        tag:
          e.group === "waiting" || e.group === "running"
            ? TASK_ATTENTION_LABELS[e.group]
            : undefined,
        run: () => {
          if (e.wsName !== null) selectWorkspace(e.sid, e.wsId);
          onSwitchMode("orchestrate");
          nav({
            ws: formatWsRef(e.sid, e.wsId),
            orchestrate: { tab: "board" as const, project: e.projectPath, task: e.task.id },
          });
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
      {
        id: "settings.open",
        title: "Open settings",
        icon: SettingsIcon,
        run: () => onOpenSettings?.(),
      },
      {
        id: "settings.theme",
        title: "Toggle light / dark theme",
        icon: SunMoon,
        run: () => {
          // From "system", jump to the opposite of what the OS is showing.
          const s = settingsStore.getState();
          const dark =
            s.theme === "dark" ||
            (s.theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
          s.set({ theme: dark ? "light" : "dark" });
        },
      },
    ];
  }, [
    onOpenSettings,
    onOpenShortcuts,
    onSwitchMode,
    onSelectWorkspace,
    createArchitecture,
    createProject,
    architectures,
    projects,
    taskEntries,
    sessionEntries,
    activeNeedsYou,
    selectWorkspace,
    nav,
    workspaces,
    recents,
    activeWsId,
    activeReviewRef,
    canSaveLens,
    client,
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
                <span className="flex-1 truncate">{cmd.title}</span>
                {cmd.tag ? (
                  <span className="shrink-0 text-[10px] text-ink-faint">{cmd.tag}</span>
                ) : null}
                {cmd.hint ? <Kbd>{cmd.hint}</Kbd> : null}
              </>
            );
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

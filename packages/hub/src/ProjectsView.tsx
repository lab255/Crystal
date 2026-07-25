import { useMemo } from "react";
import { Boxes, FolderOpen, Network, Rocket } from "lucide-react";
import {
  emptyDeliverySpend,
  isDeliveryTerminal,
  type Program,
  type ProgramDelivery,
} from "@crystal/core";
import {
  EMPTY_HUB_PROJECTS,
  EMPTY_HUB_RECENTS,
  EMPTY_PROGRAMS,
  useHub,
  useNavUpdate,
  useWorkspaces,
} from "@crystal/client";
import { Badge, Button, EmptyState, Tooltip, cn, useContextMenu } from "@crystal/ui";
import { SectionLabel, StatusBadge, copyText, useHubMenuContext } from "./common.js";
import { projectMenuEntries } from "./menus.js";

/**
 * The portfolio from the other side: every project the hub can address, and
 * what each is currently carrying. This is where cross-project load is
 * visible — a project with three live deliveries from three programs is the
 * thing you want to see before adding a fourth.
 */
export function ProjectsView({ find }: { find: string }) {
  const projects = useHub((s) => s.projects) ?? EMPTY_HUB_PROJECTS;
  const recents = useHub((s) => s.recents) ?? EMPTY_HUB_RECENTS;
  const programs = useHub((s) => s.programs) ?? EMPTY_PROGRAMS;
  const spend = useHub((s) => s.spend);
  const nav = useNavUpdate();
  const setActive = useWorkspaces((s) => s.setActive);
  const activeWs = useWorkspaces((s) => s.activeId);
  const menu = useContextMenu();
  const menuCtx = useHubMenuContext();

  /** Deliveries grouped by project root — a project may serve many programs. */
  const byRoot = useMemo(() => {
    const map = new Map<string, { program: Program; delivery: ProgramDelivery }[]>();
    for (const program of programs) {
      for (const delivery of program.deliveries) {
        const list = map.get(delivery.projectRoot) ?? [];
        list.push({ program, delivery });
        map.set(delivery.projectRoot, list);
      }
    }
    return map;
  }, [programs]);

  const needle = find.trim().toLowerCase();
  const rows = [
    ...projects.map((p) => ({ ...p, ws: p.ws as string | null })),
    ...recents.filter((r) => !r.missing).map((r) => ({ ...r, ws: null as string | null })),
  ].filter(
    (p) => !needle || p.name.toLowerCase().includes(needle) || p.root.toLowerCase().includes(needle),
  );

  if (rows.length === 0) {
    return (
      <EmptyState icon={Boxes} title="No projects">
        {needle
          ? "Nothing matches the current filter."
          : "Open a workspace and it becomes dispatchable from here."}
      </EmptyState>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto grid max-w-5xl grid-cols-1 gap-3 p-5 lg:grid-cols-2">
        {rows.map((project) => {
          const carried = byRoot.get(project.root) ?? [];
          const live = carried.filter((c) => !isDeliveryTerminal(c.delivery.status));
          const cost = carried.reduce(
            (sum, c) =>
              sum + (spend[c.program.id]?.byDelivery[c.delivery.id] ?? emptyDeliverySpend()).costUsd,
            0,
          );
          const go = (patch: Parameters<typeof nav>[0]) => {
            if (!project.ws) return;
            setActive(project.ws);
            nav({ ws: project.ws, ...patch });
          };
          return (
            <div
              key={project.root}
              className={cn(
                "rounded-xl border bg-surface-1 p-3.5",
                project.ws && project.ws === activeWs
                  ? "border-crystal-500/40"
                  : "border-edge",
              )}
              onContextMenu={(e) =>
                menu.open(e, [
                  { type: "heading", label: project.name },
                  ...(project.ws
                    ? [
                        ...projectMenuEntries(project.ws, menuCtx),
                        {
                          type: "item" as const,
                          label: "Open its workflows",
                          icon: Network,
                          onSelect: () =>
                            go({ mode: "orchestrate", orchestrate: { tab: "workflows" } }),
                        },
                        { type: "separator" as const },
                      ]
                    : []),
                  {
                    type: "item",
                    label: "Copy project path",
                    icon: FolderOpen,
                    hint: project.root,
                    onSelect: () => copyText(project.root),
                  },
                ])
              }
            >
              <div className="flex items-center gap-2">
                <Boxes className="h-4 w-4 shrink-0 text-crystal-300" />
                <span className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">
                  {project.name}
                </span>
                {project.ws ? null : <Badge tone="slate">closed</Badge>}
                {live.length ? <Badge tone="violet">{live.length} live</Badge> : null}
              </div>
              <div className="mt-0.5 truncate font-mono text-[10px] text-ink-faint">
                {project.root}
              </div>

              {carried.length ? (
                <div className="mt-2.5">
                  <SectionLabel>Deliveries</SectionLabel>
                  <div className="mt-1 space-y-1">
                    {carried.map(({ program, delivery }) => (
                      <button
                        key={delivery.id}
                        type="button"
                        onClick={() =>
                          nav({
                            mode: "hub",
                            hub: { view: "programs", program: program.id, delivery: delivery.id },
                          })
                        }
                        className="flex w-full items-center gap-1.5 rounded-lg px-1.5 py-1 text-left hover:bg-surface-2"
                      >
                        <span className="min-w-0 flex-1 truncate text-[11px] text-ink">
                          {program.name}
                        </span>
                        <StatusBadge status={delivery.status} />
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <p className="mt-2.5 text-[11px] text-ink-faint">
                  Nothing dispatched here yet.
                </p>
              )}

              <div className="mt-3 flex items-center gap-2 text-[10px] text-ink-faint">
                {cost > 0 ? <span>${cost.toFixed(2)} spent via the hub</span> : null}
                <div className="ml-auto flex items-center gap-1">
                  <Tooltip content="Dispatch an epic into this project">
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={() =>
                        nav({
                          mode: "hub",
                          // Carry the project through: the start panel opens
                          // with it selected instead of a blank form.
                          hub: { view: "programs", program: null, project: project.ws },
                        })
                      }
                    >
                      <Rocket className="h-3 w-3" /> Dispatch
                    </Button>
                  </Tooltip>
                  {project.ws ? (
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={() => go({ mode: "orchestrate", orchestrate: { tab: "workflows" } })}
                    >
                      <Network className="h-3 w-3" /> Workflows
                    </Button>
                  ) : null}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      {menu.element}
    </div>
  );
}

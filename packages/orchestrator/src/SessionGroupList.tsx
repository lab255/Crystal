import { useMemo, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, GitBranch, Plus, Search } from "lucide-react";
import {
  sessionDescendantCount,
  sessionDisplayStatus,
  sessionHeadline,
  sessionSubtreeCost,
  sessionWorkflowId,
  type RunNode,
  type SessionNamingContext,
} from "@crystal/core";
import { formatRunCost, useCollapsedSet } from "@crystal/client";
import { Button, Input, StatusDot, cn } from "@crystal/ui";
import {
  filterSessionTree,
  type AgentNameLookup,
  type SessionEpicGroup,
  type SessionProjectGroup,
} from "./session-groups.js";

export interface NewSessionScope { projectId: string | null; epicId: string | null }

export interface SessionGroupListProps {
  sessions: readonly SessionProjectGroup[];
  selectedRunId: string | null;
  attention: ReadonlySet<string>;
  agentNameOf: AgentNameLookup;
  /** One naming source: titles, search and the chip-redundancy check all read
   * namingContext — a separate workflow lookup could silently diverge. */
  namingContext: SessionNamingContext;
  onSelect: (runId: string) => void;
  onNewSession: (scope: NewSessionScope) => void;
}

const projectKey = (project: SessionProjectGroup) => project.projectId ?? "__unassigned__";
const epicKey = (project: SessionProjectGroup, epic: SessionEpicGroup) =>
  `${projectKey(project)}/${epic.epicId ?? "__no_epic__"}`;
const sessionCount = (project: SessionProjectGroup) =>
  project.epics.reduce((count, epic) => count + epic.sessions.length, 0);

export function SessionGroupList(props: SessionGroupListProps) {
  const { sessions, agentNameOf, namingContext } = props;
  const collapsed = useCollapsedSet("sessions-rail");
  const [filter, setFilter] = useState("");
  const visible = useMemo(() => {
    if (!filter.trim()) return sessions;
    return sessions.map((project) => ({
      ...project,
      epics: project.epics.map((epic) => ({
        ...epic,
        sessions: epic.sessions.map((node) => filterSessionTree(node, filter, agentNameOf, namingContext))
          .filter((node): node is RunNode => node != null),
      })).filter((epic) => epic.sessions.length > 0),
    })).filter((project) => project.epics.length > 0);
  }, [agentNameOf, filter, namingContext, sessions]);

  return <aside aria-label="Sessions" className="flex w-80 shrink-0 flex-col border-r border-edge bg-surface-1">
    <div className="relative shrink-0 border-b border-edge p-2">
      <Search className="pointer-events-none absolute left-4 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-faint" />
      <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter sessions…" aria-label="Filter sessions" className="h-8 pl-8 text-xs" />
    </div>
    <div className="min-h-0 flex-1 overflow-y-auto">
      {visible.map((project) => {
        const key = `project:${projectKey(project)}`;
        const closed = !filter.trim() && collapsed.isCollapsed(key);
        return <section key={key} className="border-b border-edge/70 last:border-b-0">
          <div className="flex items-center gap-1 px-1.5 py-1.5">
            <button type="button" aria-expanded={!closed} onClick={() => !filter.trim() && collapsed.toggle(key)} className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 py-1 text-left hover:bg-surface-2">
              <Chevron closed={closed} /><span className="min-w-0 flex-1 truncate text-xs font-semibold text-ink">{project.name}</span>
              <span className="text-[10px] tabular-nums text-ink-faint">{sessionCount(project)}</span>
            </button>
            <Button variant="ghost" size="icon-sm" aria-label={`New session in ${project.name}`} onClick={() => props.onNewSession({ projectId: project.projectId, epicId: null })}><Plus className="h-3.5 w-3.5" /></Button>
          </div>
          {!closed && <div className="pb-1.5">{project.epics.map((epic) => <EpicSection key={epicKey(project, epic)} {...props} project={project} epic={epic} collapsed={collapsed} filtering={Boolean(filter.trim())} />)}</div>}
        </section>;
      })}
      {filter.trim() && visible.length === 0 ? <p className="px-3 py-6 text-center text-xs text-ink-faint">No matching sessions</p> : null}
    </div>
  </aside>;
}

function Chevron({ closed }: { closed: boolean }) {
  const Icon = closed ? ChevronRight : ChevronDown;
  return <Icon className="h-3 w-3 shrink-0 text-ink-faint" />;
}

function EpicSection({ project, epic, collapsed, filtering, ...props }: SessionGroupListProps & { project: SessionProjectGroup; epic: SessionEpicGroup; collapsed: ReturnType<typeof useCollapsedSet>; filtering: boolean }) {
  const key = `epic:${epicKey(project, epic)}`;
  const closed = !filtering && collapsed.isCollapsed(key);
  return <section>
    <div className="flex items-center gap-1 pl-4 pr-1.5">
      <button type="button" aria-expanded={!closed} onClick={() => !filtering && collapsed.toggle(key)} className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1 py-1 text-left hover:bg-surface-2">
        <Chevron closed={closed} /><span className="min-w-0 flex-1 truncate text-[11px] font-medium text-ink-muted">{epic.name}</span>
        <span className="text-[10px] tabular-nums text-ink-faint">{epic.sessions.length}</span>
      </button>
      <Button variant="ghost" size="icon-sm" aria-label={`New session in ${epic.name}`} onClick={() => props.onNewSession({ projectId: project.projectId, epicId: epic.epicId })}><Plus className="h-3 w-3" /></Button>
    </div>
    {!closed && <div className="space-y-1 px-1.5 pb-1 pl-6">{epic.sessions.map((node) => <SessionNode key={node.run.id} node={node} root filtering={filtering} {...props} collapsed={collapsed} />)}</div>}
  </section>;
}

function SessionNode({ node, root, filtering, selectedRunId, attention, agentNameOf, namingContext, onSelect, collapsed }: {
  node: RunNode; root: boolean; filtering: boolean; selectedRunId: string | null; attention: ReadonlySet<string>;
  agentNameOf: AgentNameLookup;
  namingContext: SessionNamingContext;
  onSelect: (id: string) => void; collapsed: ReturnType<typeof useCollapsedSet>;
}) {
  // Collapse keys use the chain ROOT id: the face id is the latest turn, so
  // keying on it would re-expand a deliberately collapsed subtree on every
  // resume and leak stale keys into storage.
  const collapseKey = node.turns[0]!.id;
  const closed = !filtering && collapsed.isCollapsed(collapseKey);
  const hasWorkers = node.workers.length > 0;
  const status = sessionDisplayStatus(node, attention);
  const selected = selectedRunId != null && node.turns.some((turn) => turn.id === selectedRunId);
  // A collapsed ancestor still hints at the hidden selection, or the rail
  // shows no selected row at all.
  const selectionWithin =
    !selected &&
    closed &&
    selectedRunId != null &&
    node.workers.some((worker) => subtreeContainsRun(worker, selectedRunId));
  const cost = sessionSubtreeCost(node);
  const workerCount = root ? sessionDescendantCount(node) : 0;
  const workflowId = root ? sessionWorkflowId(node) : null;
  const headline = sessionHeadline(node, namingContext);
  const workflowName = workflowId ? namingContext.workflowNameOf?.(workflowId) : null;
  return <div>
    <div className={cn("flex rounded-lg transition-colors", selected ? "bg-crystal-500/15" : selectionWithin ? "bg-crystal-500/5" : "hover:bg-surface-2")}>
      <button type="button" disabled={!hasWorkers} aria-label={hasWorkers ? `${closed ? "Expand" : "Collapse"} workers` : undefined} onClick={() => hasWorkers && !filtering && collapsed.toggle(collapseKey)} className="w-5 shrink-0 self-stretch disabled:cursor-default">
        {hasWorkers ? <Chevron closed={closed} /> : null}
      </button>
      <button type="button" onClick={() => onSelect(node.run.id)} className="min-w-0 flex-1 py-1.5 pr-2 text-left">
        {/* Title by the chain's OPENING prompt — the face is the latest turn,
            which for steered sessions is a wake-up notice ("Worker … settled"). */}
        <span className="block truncate text-xs text-ink">{headline}</span>
        <span className="mt-0.5 flex flex-wrap items-center gap-1 text-[10px] text-ink-faint">
          <span className="truncate">{agentNameOf(node.run) || node.run.model || node.run.provider || "Agent"}</span>
          {node.run.purpose ? <Chip>{node.run.purpose}</Chip> : null}
          {node.run.branch ? <Chip><GitBranch className="h-2.5 w-2.5" />{node.run.branch}</Chip> : null}
          {node.run.terminalId ? <Chip>interactive</Chip> : null}
          {workflowId && headline !== workflowName ? <Chip>{workflowName || workflowId.slice(0, 8)}</Chip> : null}
          {workerCount > 0 ? <Chip>{workerCount} worker{workerCount === 1 ? "" : "s"}</Chip> : null}
          {cost != null && cost > 0 ? <span className="font-mono">{formatRunCost(cost)}</span> : null}
          <Status status={status} />
        </span>
      </button>
    </div>
    {hasWorkers && !closed ? <div className="mt-1 space-y-1 border-l border-edge/70 pl-3">{node.workers.map((worker) => <SessionNode key={worker.run.id} node={worker} root={false} filtering={filtering} selectedRunId={selectedRunId} attention={attention} agentNameOf={agentNameOf} namingContext={namingContext} onSelect={onSelect} collapsed={collapsed} />)}</div> : null}
  </div>;
}

function subtreeContainsRun(node: RunNode, runId: string): boolean {
  return (
    node.turns.some((turn) => turn.id === runId) ||
    node.workers.some((worker) => subtreeContainsRun(worker, runId))
  );
}

function Chip({ children }: { children: ReactNode }) { return <span className="inline-flex min-w-0 max-w-full items-center gap-0.5 rounded bg-surface-3 px-1 py-0.5 text-ink-muted"><span className="flex min-w-0 items-center gap-0.5 truncate">{children}</span></span>; }
function Status({ status }: { status: ReturnType<typeof sessionDisplayStatus> }) {
  const label = status === "needs-you" ? "Needs you" : status === "working" ? "Working" : status === "failed" ? "Failed" : "Idle";
  const dot = status === "working" ? "running" : status;
  return <span className={cn("ml-auto flex shrink-0 items-center gap-1", status === "needs-you" ? "rounded bg-warn/10 px-1 text-warn" : status === "failed" ? "text-danger" : status === "working" ? "text-ink" : "text-ink-faint")}><StatusDot status={dot} />{label}</span>;
}

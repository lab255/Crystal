import { useCallback, useEffect, useMemo, useState } from "react";
import { MessagesSquare, Plus, Timer, TerminalSquare } from "lucide-react";
import {
  attentionRunIds,
  deriveNeedsYou,
  sessionHeadline,
  type AgentProfile,
  type AgentRun,
  type RunNode,
  type WorkspaceInfo,
} from "@crystal/core";
import {
  RunSurface,
  formatElapsed,
  useAgents,
  useComposerKeydown,
  useCrystal,
  useFollowChain,
  usePermissions,
  useRunSurface,
  useTerminals,
  useWorkspace,
  useWorkspaces,
  useWorkflows,
} from "@crystal/client";
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  EmptyState,
  Select,
  Textarea,
} from "@crystal/ui";
import { messageRun } from "./message-run.js";
import { MANAGER_PREAMBLE } from "./prompt.js";
import {
  SessionGroupList,
  type NewSessionScope,
} from "./SessionGroupList.js";
import {
  groupSessionsByProject,
  sessionStatus,
  type SessionEpicGroup,
  type SessionProjectGroup,
} from "./session-groups.js";
import { canResumeSession, sameSessionScope } from "./sessions-tab-state.js";
import { spawnSession } from "./spawn-session.js";

const EMPTY_PROJECTS: WorkspaceInfo["projects"] = [];
const EMPTY_AGENTS: AgentProfile[] = [];
const NO_SCOPE: NewSessionScope = { projectId: null, epicId: null };

interface SessionLookup {
  project: SessionProjectGroup;
  epic: SessionEpicGroup;
  session: RunNode;
}

export interface SessionsTabProps {
  selectedRunId: string | null;
  onSelectRun: (runId: string) => void;
  projectFilter: string | null;
  epicFilter: string | null;
  onScopeChange: (projectId: string | null, epicId: string | null) => void;
}

function nodeContainsRun(node: RunNode, runId: string): boolean {
  return (
    node.turns.some((turn) => turn.id === runId) ||
    node.workers.some((worker) => nodeContainsRun(worker, runId))
  );
}

function findSession(
  groups: readonly SessionProjectGroup[],
  runId: string | null,
): SessionLookup | null {
  if (!runId) return null;
  for (const project of groups) {
    for (const epic of project.epics) {
      const session = epic.sessions.find((candidate) => nodeContainsRun(candidate, runId));
      if (session) return { project, epic, session };
    }
  }
  return null;
}

function sessionCount(groups: readonly SessionProjectGroup[]): number {
  return groups.reduce(
    (total, project) =>
      total + project.epics.reduce((count, epic) => count + epic.sessions.length, 0),
    0,
  );
}

function filterGroups(
  groups: readonly SessionProjectGroup[],
  projectFilter: string | null,
  epicFilter: string | null,
): SessionProjectGroup[] {
  if (!projectFilter && !epicFilter) return [...groups];

  return groups
    .filter((project) => !projectFilter || project.projectId === projectFilter)
    .map((project) => ({
      ...project,
      epics: epicFilter
        ? project.epics.filter((epic) => epic.epicId === epicFilter)
        : project.epics,
    }))
    .filter((project) => projectFilter != null || project.epics.length > 0);
}

/** Sessions-first view: grouped conversation rail beside the shared run surface. */
export function SessionsTab({
  selectedRunId,
  onSelectRun,
  projectFilter,
  epicFilter,
  onScopeChange,
}: SessionsTabProps) {
  const { client, activeSid } = useCrystal();
  const runs = useAgents((state) => state.runs);
  const projects = useWorkspace((state) => state.info?.projects ?? EMPTY_PROJECTS);
  const roster = useWorkspace((state) => state.roster);
  const agents = roster?.agents ?? EMPTY_AGENTS;
  const activeWs = useWorkspaces((state) => state.activeId);
  const focusTerminal = useTerminals((state) => state.focusTerminal);
  const pendingPermissions = usePermissions((state) => state.pending);
  const workflows = useWorkflows((state) => state.workflows);

  const agentNameOf = useCallback(
    (candidate: AgentRun) => agents.find((agent) => agent.id === candidate.agentId)?.name,
    [agents],
  );
  const workflowNameOf = useCallback(
    (id: string) => workflows.find((workflow) => workflow.id === id)?.name,
    [workflows],
  );
  const taskTitleOf = useCallback(
    (id: string) => projects.flatMap((entry) => entry.project.tasks).find((task) => task.id === id)?.title,
    [projects],
  );
  const namingContext = useMemo(
    () => ({ stripPrefixes: [MANAGER_PREAMBLE], workflowNameOf, taskTitleOf }),
    [taskTitleOf, workflowNameOf],
  );
  const attention = useMemo(
    () => attentionRunIds(deriveNeedsYou(projects, runs, pendingPermissions)),
    [pendingPermissions, projects, runs],
  );

  const groups = useMemo(() => groupSessionsByProject(runs, projects), [runs, projects]);
  const filteredGroups = useMemo(
    () => filterGroups(groups, projectFilter, epicFilter),
    [groups, projectFilter, epicFilter],
  );
  const selected = useMemo(() => findSession(groups, selectedRunId), [groups, selectedRunId]);
  const totalSessions = useMemo(() => sessionCount(groups), [groups]);
  const surface = useRunSurface(selectedRunId);
  const run = surface.run;

  const onSend = useCallback(
    async (text: string) => {
      if (!run) return;
      const result = await messageRun(client, run, text);
      if (result.runId && result.runId !== run.id) onSelectRun(result.runId);
      return result;
    },
    [client, run, onSelectRun],
  );

  useFollowChain(runs, selectedRunId, onSelectRun);

  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (run?.status !== "running" || !run.startedAt) return;
    setNowMs(Date.now());
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [run?.id, run?.startedAt, run?.status]);

  const [spawnOpen, setSpawnOpen] = useState(false);
  const [spawnScope, setSpawnScope] = useState<NewSessionScope>(NO_SCOPE);
  const [prompt, setPrompt] = useState("");
  const [agentId, setAgentId] = useState("");
  const [spawnBusy, setSpawnBusy] = useState(false);
  const [spawnError, setSpawnError] = useState<string | null>(null);

  const openSpawn = useCallback((scope: NewSessionScope) => {
    if (!sameSessionScope(scope, spawnScope)) setPrompt("");
    setSpawnScope(scope);
    setSpawnError(null);
    setSpawnOpen(true);
  }, [spawnScope]);

  const startSession = useCallback(async () => {
    const text = prompt.trim();
    if (!text || spawnBusy) return;
    setSpawnBusy(true);
    setSpawnError(null);
    try {
      const { run: spawnedRun, terminal } = await spawnSession({
        client,
        ws: activeWs ?? undefined,
        prompt: text,
        agentId: agentId || null,
        projectId: spawnScope.projectId,
        tags: spawnScope.epicId ? [`epic:${spawnScope.epicId}`] : [],
      });
      onSelectRun(spawnedRun.id);
      setPrompt("");
      setSpawnOpen(false);
      // Selection is already safe if revealing the shared terminal panel
      // fails; terminal hydration can be retried from the run surface.
      if (activeWs) await focusTerminal(activeWs, terminal.id).catch(() => {});
    } catch (error) {
      setSpawnError((error as Error).message);
    } finally {
      setSpawnBusy(false);
    }
  }, [activeWs, agentId, client, focusTerminal, onSelectRun, prompt, spawnBusy, spawnScope]);
  const onPromptKeyDown = useComposerKeydown(() => void startSession());

  const dialogProject = spawnScope.projectId
    ? groups.find((project) => project.projectId === spawnScope.projectId) ?? null
    : null;
  const dialogEpic = spawnScope.epicId
    ? dialogProject?.epics.find((epic) => epic.epicId === spawnScope.epicId) ?? null
    : null;
  const dialogContext = dialogEpic
    ? `${dialogProject?.name ?? "Project"} / ${dialogEpic.name}`
    : (dialogProject?.name ?? "Workspace");

  const faceRun = selected?.session.run ?? null;
  const terminalGone = useTerminalGone(faceRun, activeSid, activeWs);
  const settledSession = selected ? sessionStatus(selected.session) === "idle" : false;
  const canResume = canResumeSession(settledSession, faceRun, terminalGone);
  const [resumeBusy, setResumeBusy] = useState(false);
  const [resumeError, setResumeError] = useState<string | null>(null);

  useEffect(() => {
    setResumeError(null);
  }, [faceRun?.id]);

  const resumeInteractively = useCallback(async () => {
    if (!faceRun || !canResume || resumeBusy) return;
    setResumeBusy(true);
    setResumeError(null);
    try {
      const result = await client.request("agent.interactive", {
        prompt: "",
        resumeRunId: faceRun.id,
      });
      onSelectRun(result.run.id);
    } catch (error) {
      setResumeError((error as Error).message);
    } finally {
      setResumeBusy(false);
    }
  }, [canResume, client, faceRun, onSelectRun, resumeBusy]);

  const spawnDialog = (
    <Dialog open={spawnOpen} onOpenChange={setSpawnOpen}>
      <DialogContent
        title="New session"
        description={
          <span>
            Start an interactive session in <span className="text-ink">{dialogContext}</span>.
          </span>
        }
      >
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            void startSession();
          }}
        >
          <Textarea
            autoFocus
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={onPromptKeyDown}
            rows={5}
            aria-label="Session prompt"
            placeholder="What should this session work on?"
          />
          <Select
            size="sm"
            className="w-full"
            value={agentId}
            onChange={(event) => setAgentId(event.target.value)}
            aria-label="Agent profile"
          >
            <option value="">Workspace default</option>
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name} ({agent.model})
              </option>
            ))}
          </Select>
          {spawnError ? (
            <p role="alert" className="text-xs text-danger">
              {spawnError}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <DialogClose asChild>
              <Button variant="ghost" size="sm" disabled={spawnBusy}>
                Cancel
              </Button>
            </DialogClose>
            <Button
              type="submit"
              variant="primary"
              size="sm"
              disabled={spawnBusy || !prompt.trim()}
            >
              <TerminalSquare className="h-3.5 w-3.5" />
              {spawnBusy ? "Starting…" : "Start"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );

  if (totalSessions === 0) {
    return (
      <>
        <EmptyState
          icon={MessagesSquare}
          title="No sessions yet"
          action={
            <Button variant="primary" size="sm" onClick={() => openSpawn(NO_SCOPE)}>
              <Plus className="h-3.5 w-3.5" /> New session
            </Button>
          }
        >
          Start an interactive agent session, then return here to follow the conversation.
        </EmptyState>
        {spawnDialog}
      </>
    );
  }

  return (
    <>
      <div className="flex h-full min-h-0">
        <SessionGroupList
          sessions={filteredGroups}
          selectedRunId={selectedRunId}
          attention={attention}
          agentNameOf={agentNameOf}
          namingContext={namingContext}
          onSelect={onSelectRun}
          onNewSession={openSpawn}
        />
        <main className="flex min-w-0 flex-1 flex-col">
          {run ? (
            <>
              {selected ? (
                <div className="flex min-h-9 items-center gap-2 border-b border-edge bg-surface-1 px-3 py-1.5">
                  <nav
                    aria-label="Session breadcrumb"
                    className="flex min-w-0 flex-1 items-center gap-1.5 text-xs"
                  >
                    <button
                      type="button"
                      className="truncate text-ink-muted hover:text-ink"
                      onClick={() => onScopeChange(selected.project.projectId, null)}
                    >
                      {selected.project.name}
                    </button>
                    <span className="text-ink-faint">/</span>
                    <button
                      type="button"
                      className="truncate text-ink-muted hover:text-ink"
                      onClick={() =>
                        onScopeChange(selected.project.projectId, selected.epic.epicId)
                      }
                    >
                      {selected.epic.name}
                    </button>
                    <span className="text-ink-faint">/</span>
                    <span className="min-w-0 truncate font-medium text-ink">
                      {sessionHeadline(selected.session, namingContext)}
                    </span>
                  </nav>
                  {run.status === "running" && run.startedAt ? (
                    <span className="flex shrink-0 items-center gap-1 rounded-full border border-info/30 bg-info/10 px-2 py-0.5 font-mono text-[10px] text-info">
                      <Timer className="h-3 w-3" /> {formatElapsed(run.startedAt, nowMs)}
                    </span>
                  ) : null}
                  {resumeError ? (
                    <span className="max-w-48 truncate text-[10px] text-danger" title={resumeError}>
                      {resumeError}
                    </span>
                  ) : null}
                  {canResume ? (
                    <Button
                      variant="secondary"
                      size="xs"
                      disabled={resumeBusy}
                      onClick={() => void resumeInteractively()}
                    >
                      <TerminalSquare className="h-3 w-3" />
                      {resumeBusy ? "Resuming…" : "Resume interactively"}
                    </Button>
                  ) : null}
                </div>
              ) : null}
              <div className="min-h-0 flex-1">
                <RunSurface
                  run={run}
                  events={surface.events}
                  chain={surface.chain}
                  diff={surface.diff}
                  onRefreshDiff={surface.onRefreshDiff}
                  onApplyBranch={surface.onApplyBranch}
                  onDiscard={surface.onDiscard}
                  merge={surface.merge}
                  onSend={onSend}
                  onCancel={surface.onCancel}
                  onSelectTurn={onSelectRun}
                />
              </div>
            </>
          ) : (
            <EmptyState icon={MessagesSquare} title="Select a session">
              Choose a session from the rail to see its conversation, terminal, and changes.
            </EmptyState>
          )}
        </main>
      </div>
      {spawnDialog}
    </>
  );
}

/** Confirm an interactive terminal is absent only after the shared store hydrates it. */
function useTerminalGone(
  run: AgentRun | null,
  activeSid: string,
  activeWs: string | null,
): boolean {
  const terminalId = run?.terminalId ?? null;
  const ws = run?.terminalWs ?? activeWs;
  const tab = useTerminals((state) =>
    terminalId
      ? (state.tabs.find((candidate) =>
          candidate.sid === activeSid && candidate.id === terminalId
        ) ?? null)
      : null,
  );
  const ensureTerminal = useTerminals((state) => state.ensureTerminal);
  const key = run && terminalId && ws ? `${activeSid}/${ws}/${terminalId}/${run.id}` : null;
  const [missingKey, setMissingKey] = useState<string | null>(null);

  useEffect(() => {
    if (!key || !ws || !terminalId || tab) return;
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const hydrate = (isRetry: boolean) => {
      void ensureTerminal(ws, terminalId, activeSid)
        .then(() => {
          if (!cancelled) setMissingKey(key);
        })
        .catch(() => {
          if (cancelled || isRetry) return;
          retryTimer = setTimeout(() => {
            retryTimer = null;
            if (!cancelled) hydrate(true);
          }, 3000);
        });
    };
    hydrate(false);
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [activeSid, ensureTerminal, key, tab, terminalId, ws]);

  return Boolean(key && missingKey === key && !tab);
}

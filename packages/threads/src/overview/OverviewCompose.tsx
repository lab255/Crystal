import { useEffect, useMemo, useRef, useState } from "react";
import { Send } from "lucide-react";
import {
  AUTO_MODEL,
  type AgentRun,
  type AgentProfile,
  type AgentRoster,
  type WorkflowTemplate,
} from "@crystal/core";
import {
  parseWsKey,
  spawnSession,
  useComposerKeydown,
  useCrystal,
  useFleetConnections,
  useSettings,
  wsKey,
} from "@crystal/client";
import { Button, Select, Switch, Textarea } from "@crystal/ui";

const STORAGE_KEY = "crystal.overview.compose";
// Drafts are scoped per project; explicit Cancel clears one, while Escape preserves it.
const DRAFT_KEY = "crystal.overview.compose.draft";
const EMPTY_AGENTS: AgentProfile[] = [];

type ComposeKind = "thread" | "workflow";

interface SavedCompose {
  target?: string;
  kind?: ComposeKind;
}

function readSaved(): SavedCompose {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as SavedCompose;
  } catch {
    return {};
  }
}

function promptName(prompt: string): string {
  return prompt.trim().split(/\r?\n/, 1)[0]?.trim().slice(0, 120) ?? "";
}

function draftKey(projectKey: string): string {
  return `${DRAFT_KEY}:${projectKey || "~"}`;
}

function readDraft(projectKey: string): string {
  try {
    return sessionStorage.getItem(draftKey(projectKey)) ?? "";
  } catch {
    return "";
  }
}

function chooseInitialTarget(
  target: string | undefined,
  savedTarget: string | undefined,
  choices: { key: string; connection: { state: string } }[],
): string {
  if (target && choices.some((choice) => choice.key === target)) return target;
  if (savedTarget && choices.some((choice) => choice.key === savedTarget)) return savedTarget;
  return choices.find((choice) => choice.connection.state === "open")?.key ?? "";
}

export function OverviewCompose({
  target,
  onCancel,
  onStarted,
}: {
  target?: string;
  onCancel: () => void;
  onStarted: (result: { sid: string; ws: string; run: AgentRun; kind: ComposeKind }) => void;
}) {
  const connections = useFleetConnections();
  const { fleet, activeSid } = useCrystal();
  const saved = useMemo(readSaved, []);
  const choices = useMemo(() => connections.flatMap((connection) =>
    connection.workspaces.map((workspace) => ({ connection, workspace, key: wsKey(connection.sid, workspace.id) }))),
  [connections]);
  const initialTarget = chooseInitialTarget(target, saved.target, choices);
  const [projectKey, setProjectKey] = useState(initialTarget);
  const [kind, setKind] = useState<ComposeKind>(saved.kind === "workflow" ? "workflow" : "thread");
  const [prompt, setPrompt] = useState(() => readDraft(initialTarget));
  const [name, setName] = useState("");
  const [nameEdited, setNameEdited] = useState(false);
  const [templateId, setTemplateId] = useState("standard");
  const [budget, setBudget] = useState("");
  const [agentId, setAgentId] = useState("");
  const [model, setModel] = useState("");
  const [worktree, setWorktree] = useState(false);
  const [interactivePreference, setInteractivePreference] = useState(false);
  const [rosters, setRosters] = useState<Record<string, AgentRoster>>({});
  const [templates, setTemplates] = useState<Record<string, WorkflowTemplate[]>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const enterToSend = useSettings((state) => state.enterToSend);
  const selected = choices.find((choice) => choice.key === projectKey);
  const active = selected?.connection.sid === activeSid
    && selected.connection.activeWs === selected.workspace.id;
  const online = selected?.connection.state === "open";
  const hasOpenProjects = choices.some((choice) => choice.connection.state === "open");
  const interactive = Boolean(active && !worktree && interactivePreference);
  const parsedBudget = budget.trim() ? Number(budget) : null;
  const budgetValid = parsedBudget == null || (Number.isFinite(parsedBudget) && parsedBudget > 0);

  useEffect(() => {
    const frame = requestAnimationFrame(() => promptRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    if (projectKey) return;
    const next = chooseInitialTarget(target, saved.target, choices);
    if (next) {
      setProjectKey(next);
      setPrompt(readDraft(next));
    }
  }, [choices, projectKey, saved.target, target]);

  useEffect(() => {
    try {
      sessionStorage.setItem(draftKey(projectKey), prompt);
    } catch {
      // Persistence is optional.
    }
  }, [projectKey, prompt]);

  useEffect(() => {
    if (!projectKey || !online) return;
    const { sid, ws } = parseWsKey(projectKey);
    const client = fleet.clientOf(sid);
    if (!client) return;
    if (!rosters[projectKey]) {
      void client.request("agents.get", { ws }).then(
        ({ roster }) => {
          setRosters((current) => ({ ...current, [projectKey]: roster }));
          setLoadError(null);
        },
        (reason) => setLoadError(reason instanceof Error ? reason.message : String(reason)),
      );
    }
    if (kind === "workflow" && !templates[projectKey]) {
      void client.request("workflow.templates", { ws }).then(
        (result) => {
          setTemplates((current) => ({ ...current, [projectKey]: result.templates }));
          setLoadError(null);
        },
        (reason) => setLoadError(reason instanceof Error ? reason.message : String(reason)),
      );
    }
  }, [fleet, kind, online, projectKey, rosters, templates]);

  useEffect(() => {
    const disposers = connections.flatMap(({ sid }) => {
      const client = fleet.clientOf(sid);
      if (!client) return [];
      return [
        client.events.on("workspace.changed", ({ ws }) => {
          const key = wsKey(sid, ws);
          setRosters((current) => {
            if (!current[key]) return current;
            const { [key]: _stale, ...rest } = current;
            return rest;
          });
        }),
        client.events.on("workflow.templatesChanged", ({ ws }) => {
          const key = wsKey(sid, ws);
          setTemplates((current) => {
            if (!current[key]) return current;
            const { [key]: _stale, ...rest } = current;
            return rest;
          });
        }),
      ];
    });
    return () => disposers.forEach((dispose) => dispose());
  }, [connections, fleet]);

  const roster = rosters[projectKey];
  const agents = roster?.agents ?? EMPTY_AGENTS;

  async function dispatch(): Promise<void> {
    const text = prompt.trim();
    if (!text || busy || !selected || !online) return;
    setBusy(true);
    setError(null);
    const { sid, ws } = parseWsKey(projectKey);
    const client = fleet.clientOf(sid);
    try {
      if (!client) throw new Error("This bridge is disconnected.");
      const chosenAgent = agentId || null;
      const chosenModel = model.trim() || null;
      let run: AgentRun;
      if (kind === "workflow") {
        if (!budgetValid) {
          throw new Error("Budget must be a positive number.");
        }
        const result = await client.request("workflow.start", {
          ws,
          name: name.trim() || promptName(text),
          goal: text,
          templateId,
          agentId: chosenAgent,
          managerModel: chosenModel,
          budgetUsd: parsedBudget,
        });
        run = result.run;
      } else if (interactive && active && !worktree) {
        const result = await spawnSession({ client, ws, prompt: text, agentId: chosenAgent, model: chosenModel });
        run = result.run;
      } else {
        const result = await client.request("agent.start", {
          ws,
          prompt: text,
          isolation: worktree ? "worktree" : "none",
          agentId: chosenAgent,
          model: chosenModel,
        });
        run = result.run;
      }
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ target: projectKey, kind }));
      } catch {
        // Persistence is optional.
      }
      try {
        sessionStorage.removeItem(draftKey(projectKey));
      } catch {
        // Persistence is optional.
      }
      onStarted({ sid, ws, run, kind });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  const composerKeydown = useComposerKeydown(() => void dispatch());
  const cancelAndClearDraft = () => {
    try {
      sessionStorage.removeItem(draftKey(projectKey));
    } catch {
      // Persistence is optional.
    }
    onCancel();
  };
  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
      return;
    }
    composerKeydown(event);
  };
  const multiServer = connections.length > 1;
  const onPaneKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.defaultPrevented || event.key !== "Escape") return;
    if ((event.target as HTMLElement).tagName === "SELECT") return;
    event.preventDefault();
    onCancel();
  };

  return (
    <main className="min-w-0 flex-1 overflow-y-auto p-6" onKeyDown={onPaneKeyDown}>
      <div className="mx-auto w-full max-w-xl">
        <h2 className="text-sm font-semibold text-ink">New thread in project</h2>
        <p className="mt-1 text-xs text-ink-muted">Start a conversation or managed workflow in any open project.</p>
        <div className="mt-4 grid gap-3">
          <label className="grid gap-1 text-xs text-ink-muted">
            Project
            <Select value={projectKey} onChange={(event) => { const next = event.target.value; setProjectKey(next); setPrompt(readDraft(next)); setAgentId(""); }}>
              {!choices.length ? <option value="">No open projects</option> : null}
              {multiServer ? connections.map((connection) => (
                <optgroup key={connection.sid} label={connection.label}>
                  {connection.workspaces.map((workspace) => (
                    <option key={workspace.id} value={wsKey(connection.sid, workspace.id)} disabled={connection.state !== "open"}>
                      {workspace.name}{connection.state !== "open" ? " (offline)" : ""}
                    </option>
                  ))}
                </optgroup>
              )) : choices.map(({ connection, workspace, key }) => (
                <option key={key} value={key} disabled={connection.state !== "open"}>
                  {workspace.name}{connection.state !== "open" ? " (offline)" : ""}
                </option>
              ))}
            </Select>
          </label>
          <label className="grid gap-1 text-xs text-ink-muted">
            Kind
            <Select value={kind} onChange={(event) => setKind(event.target.value as ComposeKind)}>
              <option value="thread">Thread</option>
              <option value="workflow">Workflow</option>
            </Select>
          </label>
          {kind === "workflow" ? (
            <div className="grid grid-cols-2 gap-3">
              <label className="grid gap-1 text-xs text-ink-muted">
                Template
                <Select value={templateId} onChange={(event) => setTemplateId(event.target.value)}>
                  {(templates[projectKey] ?? []).map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}
                  {!templates[projectKey]?.length ? <option value="standard">Standard</option> : null}
                </Select>
              </label>
              <label className="grid gap-1 text-xs text-ink-muted">
                Budget USD
                <input className="h-8 rounded-md border border-edge bg-surface-1 px-2 text-xs text-ink" type="number" min="0.01" step="0.01" placeholder="Optional" value={budget} onChange={(event) => setBudget(event.target.value)} />
              </label>
              <label className="col-span-2 grid gap-1 text-xs text-ink-muted">
                Name
                <input className="h-8 rounded-md border border-edge bg-surface-1 px-2 text-xs text-ink" value={name} placeholder="Defaults to the first prompt line" onChange={(event) => { setName(event.target.value); setNameEdited(true); }} />
              </label>
            </div>
          ) : null}
          <Textarea
            ref={promptRef}
            autoFocus
            rows={6}
            aria-label="New thread prompt"
            placeholder={`What should the agent do? (${enterToSend === "enter" ? "Enter" : "Ctrl+Enter"} to start)`}
            value={prompt}
            onChange={(event) => { const value = event.target.value; setPrompt(value); if (!nameEdited) setName(promptName(value)); }}
            onKeyDown={onKeyDown}
          />
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-1.5 text-xs text-ink-muted">
              Profile
              <Select size="sm" className="w-44" value={agentId} onChange={(event) => setAgentId(event.target.value)}>
                <option value="">Default{roster?.defaultAgentId ? "" : " (none)"}</option>
                {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}{agent.model !== AUTO_MODEL ? ` · ${agent.model}` : ""}</option>)}
              </Select>
            </label>
            <label className="flex items-center gap-1.5 text-xs text-ink-muted">
              Model
              <input aria-label="Model override" className="h-7 w-72 rounded-md border border-edge bg-surface-1 px-2 text-xs text-ink" value={model} placeholder="e.g. claude-sonnet-5 — leave blank for the profile default" onChange={(event) => setModel(event.target.value)} />
            </label>
          </div>
          {kind === "thread" ? (
            <div className="flex flex-wrap items-center gap-4 text-xs text-ink-muted">
              <label className="flex items-center gap-1.5"><Switch aria-label="Isolate in a git worktree" checked={worktree} onChange={(value) => { setWorktree(value); if (value) setInteractivePreference(false); }} /> Isolate in a git worktree</label>
              {active ? <label className="flex items-center gap-1.5"><Switch aria-label="Interactive terminal" checked={interactive} onChange={(value) => { setInteractivePreference(value); if (value) setWorktree(false); }} /> Interactive terminal</label> : <span>Open the project to start an interactive session.</span>}
            </div>
          ) : null}
          {error ? <p role="alert" className="text-xs text-danger">{error}</p> : null}
          {loadError ? <p role="alert" className="text-xs text-danger">{loadError}</p> : null}
          <div className="flex justify-end gap-2">
            {!hasOpenProjects ? <span className="self-center text-xs text-ink-muted">No open projects</span> : null}
            <Button variant="ghost" size="sm" onClick={cancelAndClearDraft}>Cancel</Button>
            <Button variant="primary" size="sm" title={!hasOpenProjects ? "No open projects" : !budgetValid ? "Budget must be a positive number or empty" : undefined} disabled={busy || !prompt.trim() || !selected || !online || !budgetValid} onClick={() => void dispatch()}>
              <Send className="h-3.5 w-3.5" /> {busy ? "Starting…" : "Start"}
            </Button>
          </div>
        </div>
      </div>
    </main>
  );
}

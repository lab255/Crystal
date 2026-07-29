import { useMemo, useState } from "react";
import {
  ArrowLeft,
  Bot,
  Play,
  Plus,
  ShieldCheck,
  Sparkles,
  TerminalSquare,
  Trash2,
  UserCog,
  Wand2,
} from "lucide-react";
import {
  AGENT_PERMISSION_MODES,
  AGENT_PROFILE_KINDS,
  AGENT_PROFILE_SCOPES,
  MODEL_HINTS,
  MODEL_PRESETS,
  RUN_PURPOSES,
  agentTag,
  createAgentProfile,
  isAgentTag,
  presetById,
  type AgentPermissionMode,
  type AgentProfile,
  type AgentProfileScope,
  type RunPurpose,
} from "@crystal/core";
import {
  formatRunCost,
  useAgents,
  useCrystal,
  useGrants,
  useTerminals,
  useWorkflows,
  useWorkspace,
  useWorkspaces,
} from "@crystal/client";
import { Badge, Button, EmptyState, Field, Input, Select, Textarea, cn } from "@crystal/ui";
import { MANAGER_PREAMBLE } from "./prompt.js";
import { RunsPane } from "./RunsPane.js";

const EMPTY_PROFILES: AgentProfile[] = [];

/**
 * The roster surface: durable named agents, not just a dispatch form. Left,
 * the workspace's profiles (project + library sections, spend-per-profile
 * from the `agent:<id>` tag) plus the roster-level defaults; right, the
 * profile editor with the dispatch composer beneath it. Selecting a run
 * (e.g. right after dispatching) swaps the whole surface for the shared
 * {@link RunsPane} until the user returns to the roster.
 */
export function AgentsTab({
  selectedRunId,
  onSelectRun,
}: {
  selectedRunId: string | null;
  onSelectRun: (id: string | null) => void;
}) {
  const runs = useAgents((s) => s.runs);
  const roster = useWorkspace((s) => s.roster);
  const updateRoster = useWorkspace((s) => s.updateRoster);

  const profiles = roster?.agents ?? EMPTY_PROFILES;
  const [profileId, setProfileId] = useState<string | null>(null);
  /** Unsaved profile being created — becomes real on first Save. */
  const [draftNew, setDraftNew] = useState<AgentProfile | null>(null);
  const selectedProfile = draftNew ?? profiles.find((p) => p.id === profileId) ?? null;

  // Spend per profile off the `agent:<id>` tag — one pass over the run list
  // per change (same reasoning as the workflow list's spendById): `runs`
  // gets a new reference on every usage tick of any live agent.
  const spendByTag = useMemo(() => {
    const byTag = new Map<string, number>();
    for (const r of runs) {
      if (r.costUsd == null) continue;
      for (const t of r.tags) {
        if (isAgentTag(t)) byTag.set(t, (byTag.get(t) ?? 0) + r.costUsd);
      }
    }
    return byTag;
  }, [runs]);

  // Watching a run replaces the roster surface with the shared runs pane.
  if (selectedRunId) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex items-center gap-2 border-b border-edge px-3 py-1.5">
          <Button variant="ghost" size="sm" onClick={() => onSelectRun(null)}>
            <ArrowLeft className="h-3.5 w-3.5" /> Roster
          </Button>
          <span className="truncate text-[11px] text-ink-faint">
            Dispatched runs — every path in streams into the same tree
          </span>
        </div>
        <div className="min-h-0 flex-1">
          <RunsPane
            runs={runs}
            selectedRunId={selectedRunId}
            onSelect={onSelectRun}
            title="Agents"
            emptyHint="No agents dispatched yet."
          />
        </div>
      </div>
    );
  }

  const sections: { scope: AgentProfileScope; label: string }[] = [
    { scope: "project", label: "Project" },
    { scope: "library", label: "Library" },
  ];

  return (
    <div className="flex h-full min-h-0">
      <aside className="flex w-72 shrink-0 flex-col border-r border-edge bg-surface-1">
        <div className="flex items-center gap-2 px-3 py-2.5">
          <Sparkles className="h-3.5 w-3.5 text-crystal-300" />
          <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
            Agents
          </span>
          <Button
            variant="ghost"
            size="xs"
            className="ml-auto"
            onClick={() => {
              setDraftNew(createAgentProfile("New agent", "generic", "sonnet"));
              setProfileId(null);
            }}
          >
            <Plus className="h-3 w-3" /> New agent
          </Button>
        </div>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-1.5 pb-2">
          {sections.map(({ scope, label }) => {
            const inScope = profiles.filter((p) => p.scope === scope);
            if (!inScope.length && scope === "library") return null;
            return (
              <div key={scope}>
                <div className="px-2 pb-1 text-[10px] font-medium uppercase tracking-wider text-ink-faint">
                  {label}
                </div>
                {inScope.length === 0 ? (
                  <p className="px-2 py-1 text-[11px] text-ink-faint">No project agents yet.</p>
                ) : (
                  inScope.map((p) => (
                    <ProfileRow
                      key={p.id}
                      profile={p}
                      spendUsd={spendByTag.get(agentTag(p.id))}
                      isDefault={p.id === roster?.defaultAgentId}
                      isManager={p.id === roster?.managerAgentId}
                      selected={selectedProfile?.id === p.id}
                      onSelect={() => {
                        setDraftNew(null);
                        setProfileId(p.id);
                      }}
                    />
                  ))
                )}
              </div>
            );
          })}
          {draftNew ? (
            <div className="px-2 text-[11px] text-crystal-300">
              New agent — unsaved. Fill in the editor and Save.
            </div>
          ) : null}
        </div>
        {/* Roster-level policy: which profile untagged work and managers run as. */}
        {roster ? (
          <div className="shrink-0 space-y-1.5 border-t border-edge px-3 py-2">
            <label className="flex items-center gap-2 text-[11px] text-ink-muted">
              <span className="w-16 shrink-0">Preset</span>
              <Select
                size="xs"
                className="min-w-0 flex-1"
                value={presetById(roster.preset).id}
                onChange={(e) => updateRoster({ ...roster, preset: e.target.value })}
                aria-label="Model preset"
                title={presetById(roster.preset).description}
              >
                {MODEL_PRESETS.map((p) => (
                  <option key={p.id} value={p.id} title={p.description}>
                    {p.name} — {p.description}
                  </option>
                ))}
              </Select>
            </label>
            <label className="flex items-center gap-2 text-[11px] text-ink-muted">
              <span className="w-16 shrink-0">Default</span>
              <Select
                size="xs"
                className="min-w-0 flex-1"
                value={roster.defaultAgentId ?? ""}
                onChange={(e) =>
                  updateRoster({ ...roster, defaultAgentId: e.target.value || null })
                }
                aria-label="Default agent"
              >
                <option value="">First generic</option>
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </label>
            <label className="flex items-center gap-2 text-[11px] text-ink-muted">
              <span className="w-16 shrink-0">Manager</span>
              <Select
                size="xs"
                className="min-w-0 flex-1"
                value={roster.managerAgentId ?? ""}
                onChange={(e) =>
                  updateRoster({ ...roster, managerAgentId: e.target.value || null })
                }
                aria-label="Manager agent"
              >
                <option value="">Follows default</option>
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </label>
            <label
              className="flex items-center gap-2 text-[11px] text-ink-muted"
              title="Allow profiles with permission mode 'bypassPermissions' to run with all permission prompts skipped (--dangerously-skip-permissions). Off, such runs are downgraded to acceptEdits. Workspace-wide consent — leave off unless you trust every dispatch in this workspace."
            >
              <span className="w-16 shrink-0">Bypass</span>
              <span className="flex min-w-0 flex-1 items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={roster.allowBypassPermissions}
                  onChange={(e) =>
                    updateRoster({ ...roster, allowBypassPermissions: e.target.checked })
                  }
                  aria-label="Allow bypass-permissions runs in this workspace"
                />
                <span className={roster.allowBypassPermissions ? "text-warn" : undefined}>
                  {roster.allowBypassPermissions
                    ? "dangerously-skip-permissions allowed"
                    : "permission prompts enforced"}
                </span>
              </span>
            </label>
          </div>
        ) : null}
      </aside>

      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-5">
          {selectedProfile ? (
            <ProfileEditor
              key={selectedProfile.id}
              profile={selectedProfile}
              isNew={draftNew != null}
              onSaved={(saved) => {
                setDraftNew(null);
                setProfileId(saved.id);
              }}
              onDeleted={() => {
                setDraftNew(null);
                setProfileId(null);
              }}
              onClose={() => {
                setDraftNew(null);
                setProfileId(null);
              }}
            />
          ) : null}
          <DispatchPanel profiles={profiles} onDispatched={onSelectRun} />
          <GrantsPanel />
        </div>
      </main>
    </div>
  );
}

/**
 * Approvals as first-class workspace data: the granted tool patterns every
 * agent run gets (editable — applied additively at the next spawn), and the
 * permission-denial tally beneath them. A denial row is the ledger's whole
 * point: "this delivery requested this tool and was refused, N times" is
 * readable here instead of being archaeology across run transcripts.
 */
function GrantsPanel() {
  const ledger = useGrants((s) => s.ledger);
  const setTools = useGrants((s) => s.setTools);
  const workflows = useWorkflows((s) => s.workflows);
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const granted = ledger?.allowedTools ?? [];
  const denials = useMemo(
    () => [...(ledger?.denials ?? [])].sort((a, b) => (a.lastAt < b.lastAt ? 1 : -1)),
    [ledger],
  );
  const workflowName = (id: string | null | undefined) =>
    id ? (workflows.find((w) => w.id === id)?.name ?? id) : null;

  async function save(): Promise<void> {
    if (draft == null || busy) return;
    setBusy(true);
    setError(null);
    try {
      await setTools(splitLines(draft));
      setDraft(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-xl border border-edge bg-surface-1 p-3">
      <div className="mb-2 flex items-center gap-2">
        <ShieldCheck className="h-4 w-4 text-crystal-300" />
        <span className="text-[13px] font-semibold text-ink">Tool grants</span>
        <span className="text-[11px] text-ink-faint">
          workspace-wide, applied to every run at spawn
        </span>
      </div>
      <Field
        label="Granted tools"
        hint="One --allowedTools pattern per line (e.g. WebFetch, Bash(gh:*)) — additive over profile allowlists; applies to the next run"
      >
        <Textarea
          value={draft ?? granted.join("\n")}
          onChange={(e) => setDraft(e.target.value)}
          rows={3}
          placeholder={"WebFetch\nBash(gh:*)"}
          aria-label="Granted tools"
          className="font-mono text-xs"
        />
      </Field>
      {draft != null ? (
        <div className="mt-1.5 flex items-center gap-2">
          <Button variant="primary" size="xs" disabled={busy} onClick={() => void save()}>
            Save grants
          </Button>
          <Button variant="ghost" size="xs" disabled={busy} onClick={() => setDraft(null)}>
            Discard
          </Button>
        </div>
      ) : null}
      {error ? <p className="mt-1.5 text-[11px] text-danger">{error}</p> : null}

      <div className="mt-3 border-t border-edge pt-2">
        <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
          Denied requests
        </div>
        {denials.length === 0 ? (
          <p className="text-[11px] text-ink-faint">
            No permission denials recorded — runs that bounce off an ungranted tool land here.
          </p>
        ) : (
          <ul className="space-y-1">
            {denials.map((d) => (
              <li
                key={`${d.tool} ${d.workflowId ?? ""}`}
                className="flex items-center gap-2 text-[11px] text-ink-muted"
              >
                <span className="rounded bg-surface-3 px-1.5 py-0.5 font-mono text-[10px] text-ink">
                  {d.tool}
                </span>
                <span className="min-w-0 truncate">
                  {workflowName(d.workflowId) ?? "outside any workflow"}
                </span>
                <span className="ml-auto shrink-0 text-danger">
                  denied {d.count}×
                </span>
                <span className="shrink-0 text-ink-faint">
                  {new Date(d.lastAt).toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** One roster row: name, kind, model, spend, default/manager badges. */
function ProfileRow({
  profile,
  spendUsd,
  isDefault,
  isManager,
  selected,
  onSelect,
}: {
  profile: AgentProfile;
  spendUsd: number | undefined;
  isDefault: boolean;
  isManager: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "block w-full rounded-lg px-2 py-1.5 text-left transition-colors",
        selected ? "bg-crystal-500/15" : "hover:bg-surface-2",
      )}
    >
      <span className="flex items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate text-xs text-ink">{profile.name}</span>
        {isDefault ? <Badge tone="violet">default</Badge> : null}
        {isManager ? <Badge tone="cyan">manager</Badge> : null}
      </span>
      <span className="mt-0.5 flex items-center gap-1.5 text-[10px] text-ink-faint">
        <span>{profile.kind}</span>
        <span className="rounded-full bg-surface-3 px-1.5 font-mono text-[9px] text-ink-muted">
          {profile.model}
        </span>
        <span className="ml-auto">{formatRunCost(spendUsd)}</span>
      </span>
    </button>
  );
}

const splitCommas = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);
const splitLines = (s: string) => s.split("\n").map((x) => x.trim()).filter(Boolean);

/**
 * The profile editor — identity (name/kind/model), standing behavior
 * (appendPrompt, tool policy, permission mode), dispatch defaults and the
 * storage scope. Save is explicit (`agents.saveProfile`); saving with a
 * changed scope *moves* the record between `.crystal/agents.json` and the
 * shared `~/.crystal/agents` library.
 */
function ProfileEditor({
  profile,
  isNew,
  onSaved,
  onDeleted,
  onClose,
}: {
  profile: AgentProfile;
  isNew: boolean;
  onSaved: (profile: AgentProfile) => void;
  onDeleted: () => void;
  onClose: () => void;
}) {
  const { client } = useCrystal();
  const [name, setName] = useState(profile.name);
  const [kind, setKind] = useState(profile.kind);
  const [model, setModel] = useState(profile.model);
  const [skills, setSkills] = useState(profile.skills.join(", "));
  const [tags, setTags] = useState(profile.tags.join(", "));
  const [appendPrompt, setAppendPrompt] = useState(profile.appendPrompt ?? "");
  const [allowedTools, setAllowedTools] = useState((profile.allowedTools ?? []).join("\n"));
  const [disallowedTools, setDisallowedTools] = useState(
    (profile.disallowedTools ?? []).join("\n"),
  );
  const [permissionMode, setPermissionMode] = useState<"" | AgentPermissionMode>(
    profile.permissionMode ?? "",
  );
  const [purpose, setPurpose] = useState<"" | RunPurpose>(profile.defaults?.purpose ?? "");
  const [isolate, setIsolate] = useState(profile.defaults?.isolation === "worktree");
  const [scope, setScope] = useState<AgentProfileScope>(profile.scope);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const scopeMoves = !isNew && scope !== profile.scope;

  async function save(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    const allowed = splitLines(allowedTools);
    const disallowed = splitLines(disallowedTools);
    const next: AgentProfile = {
      ...profile,
      name: name.trim() || profile.name,
      kind,
      model: model.trim() || "sonnet",
      skills: splitCommas(skills),
      tags: splitCommas(tags),
      appendPrompt: appendPrompt.trim() || undefined,
      allowedTools: allowed.length ? allowed : undefined,
      disallowedTools: disallowed.length ? disallowed : undefined,
      permissionMode: permissionMode || undefined,
      defaults:
        purpose || isolate
          ? {
              purpose: purpose || undefined,
              isolation: isolate ? ("worktree" as const) : undefined,
            }
          : undefined,
      scope,
    };
    try {
      const { profile: saved } = await client.request("agents.saveProfile", {
        profile: next,
        scope,
      });
      onSaved(saved);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await client.request("agents.removeProfile", { id: profile.id });
      onDeleted();
    } catch (err) {
      // The server refuses deleting the roster's default agent — surface it.
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-xl border border-edge bg-surface-1 p-3">
      <div className="mb-2 flex items-center gap-2">
        <UserCog className="h-4 w-4 text-crystal-300" />
        <span className="text-[13px] font-semibold text-ink">
          {isNew ? "New agent" : profile.name}
        </span>
        <Badge tone={scope === "library" ? "cyan" : "slate"}>{scope}</Badge>
        <Button variant="ghost" size="xs" className="ml-auto" onClick={onClose}>
          Close
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Field label="Name">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-label="Agent name"
            className="h-7 text-xs"
          />
        </Field>
        <Field label="Kind" hint="Specialists win dispatch for tasks whose tags overlap">
          <Select
            size="sm"
            value={kind}
            onChange={(e) => setKind(e.target.value as AgentProfile["kind"])}
            aria-label="Agent kind"
          >
            {AGENT_PROFILE_KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Model" hint="Claude model alias or id, passed as --model">
          <Input
            value={model}
            onChange={(e) => setModel(e.target.value)}
            list="agent-model-hints"
            aria-label="Agent model"
            className="h-7 font-mono text-xs"
          />
          <datalist id="agent-model-hints">
            {MODEL_HINTS.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </Field>
        <Field label="Skills" hint="Comma-separated, woven into dispatch prompts">
          <Input
            value={skills}
            onChange={(e) => setSkills(e.target.value)}
            placeholder="e.g. security-review, dataviz"
            aria-label="Agent skills"
            className="h-7 text-xs"
          />
        </Field>
        <Field label="Tags" hint="Context tags this specialist owns (auto-assignment)">
          <Input
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder="e.g. intent:auth, sys:forms"
            aria-label="Agent tags"
            className="h-7 text-xs"
          />
        </Field>
        <Field
          label="Permission mode"
          hint="Unset keeps acceptEdits (headless default); bypassPermissions needs the workspace Bypass toggle"
        >
          <Select
            size="sm"
            value={permissionMode}
            onChange={(e) => setPermissionMode(e.target.value as "" | AgentPermissionMode)}
            aria-label="Permission mode"
          >
            <option value="">Unset — acceptEdits</option>
            {AGENT_PERMISSION_MODES.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <Field
        label="Standing instructions"
        hint="Passed as --append-system-prompt on every run, so they survive --resume turns"
        className="mt-2"
      >
        <Textarea
          value={appendPrompt}
          onChange={(e) => setAppendPrompt(e.target.value)}
          rows={3}
          placeholder="Durable behavior for this agent — style, constraints, review bar…"
          aria-label="Standing instructions"
          className="text-xs"
        />
      </Field>

      <div className="mt-2 grid grid-cols-2 gap-2">
        <Field label="Allowed tools" hint="One pattern per line, merged over the run allowlist">
          <Textarea
            value={allowedTools}
            onChange={(e) => setAllowedTools(e.target.value)}
            rows={3}
            placeholder={"Bash(pnpm *)\nWebSearch"}
            aria-label="Allowed tools"
            className="font-mono text-xs"
          />
        </Field>
        <Field label="Disallowed tools" hint="One pattern per line — --disallowedTools">
          <Textarea
            value={disallowedTools}
            onChange={(e) => setDisallowedTools(e.target.value)}
            rows={3}
            placeholder={"WebFetch\nBash(git push*)"}
            aria-label="Disallowed tools"
            className="font-mono text-xs"
          />
        </Field>
      </div>

      <div className="mt-2 flex items-center gap-3">
        <Field label="Default purpose" className="flex-1">
          <Select
            size="sm"
            value={purpose}
            onChange={(e) => setPurpose(e.target.value as "" | RunPurpose)}
            aria-label="Default purpose"
          >
            <option value="">None</option>
            {RUN_PURPOSES.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </Select>
        </Field>
        <label className="mt-4 flex cursor-pointer items-center gap-1.5 text-[11px] text-ink-muted">
          <input
            type="checkbox"
            checked={isolate}
            onChange={(e) => setIsolate(e.target.checked)}
            className="h-3 w-3 accent-[var(--color-crystal-500)]"
          />
          Isolate in a worktree by default
        </label>
      </div>

      <div className="mt-3 flex items-center gap-2 border-t border-edge pt-2">
        <Field label="Scope" className="w-44">
          <Select
            size="sm"
            value={scope}
            onChange={(e) => setScope(e.target.value as AgentProfileScope)}
            aria-label="Profile scope"
          >
            {AGENT_PROFILE_SCOPES.map((s) => (
              <option key={s} value={s}>
                {s === "project" ? "project — .crystal/agents.json" : "library — ~/.crystal/agents"}
              </option>
            ))}
          </Select>
        </Field>
        {scopeMoves ? (
          <span className="text-[10px] text-warn">
            Saving moves this profile to the {scope} scope — one id never lives in both.
          </span>
        ) : null}
        <span className="ml-auto flex items-center gap-2">
          {!isNew ? (
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => void remove()}>
              <Trash2 className="h-3 w-3 text-danger" /> Delete
            </Button>
          ) : null}
          <Button variant="primary" size="sm" disabled={busy} onClick={() => void save()}>
            {isNew ? "Create" : "Save"}
          </Button>
        </span>
      </div>
      {error ? <p className="mt-2 text-[11px] text-danger">{error}</p> : null}
    </div>
  );
}

/** A predefined job, dispatched with one click and tracked like any run. */
interface JobTemplate {
  id: "index" | "review";
  label: string;
  hint: string;
  icon: typeof Sparkles;
}

const JOB_TEMPLATES: JobTemplate[] = [
  {
    id: "index",
    label: "Index intents",
    hint: "Tag changed symbols' intent",
    icon: Sparkles,
  },
  {
    id: "review",
    label: "Review working tree",
    hint: "Correctness + quality pass on the diff",
    icon: Wand2,
  },
];

const EMPTY_REPOS: never[] = [];

function DispatchPanel({
  profiles,
  onDispatched,
}: {
  profiles: AgentProfile[];
  onDispatched: (id: string) => void;
}) {
  const { client } = useCrystal();
  const start = useAgents((s) => s.start);
  const repos = useWorkspace((s) => s.info?.manifest.repos ?? EMPTY_REPOS);
  const activeWs = useWorkspaces((s) => s.activeId);
  const focusTerminal = useTerminals((s) => s.focusTerminal);

  const [prompt, setPrompt] = useState("");
  const [manager, setManager] = useState(true);
  const [purpose, setPurpose] = useState<RunPurpose>("implement");
  const [cwd, setCwd] = useState(".");
  const [isolate, setIsolate] = useState(false);
  /** "" = raw dispatch (no profile overlay). */
  const [agentId, setAgentId] = useState("");
  /** "" = the profile's model (or the CLI default on a raw dispatch). */
  const [modelOverride, setModelOverride] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const repoId = repos.find((r) => r.path === cwd)?.id ?? null;

  /**
   * Interactive is the default dispatch: the native Claude TUI on a workspace
   * PTY, questions answered right in the terminal panel. Headless (`-p`
   * stream-json) stays one button away — worktree isolation implies it, since
   * an interactive session lives in the repo checkout.
   */
  async function dispatch(interactive: boolean): Promise<void> {
    const text = prompt.trim();
    if (!text) return;
    setBusy(true);
    setError(null);
    try {
      const params = {
        prompt: manager ? MANAGER_PREAMBLE + text : text,
        cwd,
        repoId,
        role: manager ? ("manager" as const) : null,
        purpose,
        agentId: agentId || null,
        tags: manager ? ["role:manager", `purpose:${purpose}`] : [`purpose:${purpose}`],
        model: modelOverride.trim() || null,
      };
      if (interactive && !isolate) {
        const { run, terminal } = await client.request("agent.interactive", params);
        setPrompt("");
        if (activeWs) await focusTerminal(activeWs, terminal.id);
        onDispatched(run.id);
      } else {
        const run = await start({ ...params, isolation: isolate ? "worktree" : "none" });
        setPrompt("");
        onDispatched(run.id);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function runTemplate(tpl: JobTemplate): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      if (tpl.id === "index") {
        const { run } = await client.request("codeindex.enrich", {});
        onDispatched(run.id);
      } else {
        const run = await start({
          prompt:
            "Review the current working-tree diff for correctness bugs and " +
            "quality issues (reuse, simplification, efficiency). List findings " +
            "with file:line and a short rationale each.",
          cwd,
          repoId,
          purpose: "code-review",
          tags: ["purpose:code-review"],
        });
        onDispatched(run.id);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-xl border border-crystal-500/25 bg-crystal-500/5 p-3">
        <div className="mb-2 flex items-center gap-2">
          <Bot className="h-4 w-4 text-crystal-300" />
          <span className="text-[13px] font-semibold text-ink">Dispatch an agent</span>
        </div>
        <Textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void dispatch(!isolate);
          }}
          rows={5}
          placeholder={
            manager
              ? "Describe the goal — the manager will break it down and dispatch workers…"
              : "Describe the task for a single agent…"
          }
          aria-label="Agent prompt"
        />
        <label className="mt-2 flex cursor-pointer items-center gap-1.5 text-[11px] text-ink-muted">
          <input
            type="checkbox"
            checked={manager}
            onChange={(e) => setManager(e.target.checked)}
            className="h-3 w-3 accent-[var(--color-crystal-500)]"
          />
          <UserCog className="h-3.5 w-3.5" />
          Manager mode — delegate to worker agents
        </label>
        <div className="mt-2 flex items-center gap-2">
          <Select
            size="sm"
            className="flex-1"
            value={agentId}
            onChange={(e) => setAgentId(e.target.value)}
            aria-label="Agent profile"
          >
            <option value="">No profile — raw dispatch</option>
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.model})
              </option>
            ))}
          </Select>
          <Input
            value={modelOverride}
            onChange={(e) => setModelOverride(e.target.value)}
            list="dispatch-model-hints"
            placeholder="model override"
            aria-label="Model override"
            className="h-7 w-36 font-mono text-xs"
          />
          <datalist id="dispatch-model-hints">
            {MODEL_HINTS.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </div>
        <div className="mt-2 flex items-center gap-2">
          <Select
            size="sm"
            className="flex-1"
            value={purpose}
            onChange={(e) => setPurpose(e.target.value as RunPurpose)}
            aria-label="Run purpose"
          >
            {RUN_PURPOSES.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </Select>
          <Select
            size="sm"
            className="flex-1"
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            aria-label="Working directory"
          >
            <option value=".">workspace root</option>
            {repos
              .filter((r) => r.path !== ".")
              .map((r) => (
                <option key={r.id} value={r.path}>
                  {r.name}
                </option>
              ))}
          </Select>
          <Button
            variant="primary"
            size="sm"
            disabled={busy || !prompt.trim()}
            onClick={() => void dispatch(!isolate)}
            title={
              isolate
                ? "Worktree isolation implies a headless run — the diff is reviewed from the run surface"
                : "Run as a native interactive Claude session in the terminal panel"
            }
          >
            {isolate ? <Play className="h-3 w-3" /> : <TerminalSquare className="h-3 w-3" />}{" "}
            Dispatch
          </Button>
          {!isolate ? (
            <Button
              variant="secondary"
              size="sm"
              disabled={busy || !prompt.trim()}
              onClick={() => void dispatch(false)}
              title="Run headless (stream-json in the background) — watch it from the runs list"
            >
              <Play className="h-3 w-3" /> Headless
            </Button>
          ) : null}
        </div>
        <label className="mt-2 flex cursor-pointer items-center gap-1.5 text-[11px] text-ink-muted">
          <input
            type="checkbox"
            checked={isolate}
            onChange={(e) => setIsolate(e.target.checked)}
            className="h-3 w-3 accent-[var(--color-crystal-500)]"
          />
          Isolate in a git worktree
          <span className="text-ink-faint">— parallel-safe, review the diff before applying</span>
        </label>
        {error ? <p className="mt-2 text-[11px] text-danger">{error}</p> : null}
      </div>

      <div>
        <h3 className="mb-1.5 px-1 text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
          Templates
        </h3>
        <div className="grid grid-cols-2 gap-2">
          {JOB_TEMPLATES.map((tpl) => (
            <button
              key={tpl.id}
              type="button"
              disabled={busy}
              onClick={() => void runTemplate(tpl)}
              className="flex items-start gap-2.5 rounded-xl border border-edge bg-surface-1 p-3 text-left transition-colors hover:border-edge-strong disabled:opacity-50"
            >
              <tpl.icon className="mt-0.5 h-4 w-4 shrink-0 text-crystal-300" />
              <span className="min-w-0">
                <span className="block text-[13px] font-semibold text-ink">{tpl.label}</span>
                <span className="block text-[11px] text-ink-faint">{tpl.hint}</span>
              </span>
            </button>
          ))}
        </div>
      </div>

      <EmptyState icon={Bot} title="One run tree">
        Manager runs, their workers, single agents and templates all stream into the runs list
        — dispatching opens it.
      </EmptyState>
    </div>
  );
}

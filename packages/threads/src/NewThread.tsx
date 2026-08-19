import { useMemo, useState } from "react";
import { Send } from "lucide-react";
import { AUTO_MODEL, type AgentProfile } from "@crystal/core";
import {
  spawnSession,
  useAgents,
  useComposerKeydown,
  useCrystal,
  useSettings,
  useWorkspace,
} from "@crystal/client";
import { Button, Select, Switch, Textarea, cn } from "@crystal/ui";

const EMPTY_AGENTS: AgentProfile[] = [];

/**
 * The new-thread composer: one prompt, a profile, and the isolation choice.
 * Interactive by default — the native Claude TUI on a workspace PTY, the same
 * conversation this mode then follows headlessly after the terminal closes.
 * Worktree isolation implies a headless run (a PTY session works in the live
 * repo).
 */
export function NewThread({
  onStarted,
  className,
}: {
  /** The started run's id — select it as the new thread. */
  onStarted: (runId: string) => void;
  className?: string;
}) {
  const { client } = useCrystal();
  const roster = useWorkspace((s) => s.roster);
  const start = useAgents((s) => s.start);
  const [prompt, setPrompt] = useState("");
  const [agentId, setAgentId] = useState<string>("");
  const [model, setModel] = useState("");
  const [worktree, setWorktree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const enterToSend = useSettings((s) => s.enterToSend);

  const agents = roster?.agents ?? EMPTY_AGENTS;
  const profile = useMemo(
    () => agents.find((a) => a.id === (agentId || roster?.defaultAgentId)) ?? null,
    [agents, agentId, roster],
  );

  async function dispatch(): Promise<void> {
    const text = prompt.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    try {
      const chosenAgent = agentId || null;
      const chosenModel = model.trim() || null;
      if (worktree) {
        const run = await start({
          prompt: text,
          isolation: "worktree",
          agentId: chosenAgent,
          model: chosenModel,
        });
        onStarted(run.id);
      } else {
        const result = await spawnSession({
          client,
          prompt: text,
          agentId: chosenAgent,
          model: chosenModel,
        });
        onStarted(result.run.id);
      }
      setPrompt("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const onKeydown = useComposerKeydown(() => void dispatch());
  const sendHint = enterToSend === "enter" ? "Enter to start" : "Ctrl+Enter to start";

  return (
    <div className={cn("flex h-full min-h-0 flex-col items-center overflow-y-auto p-6", className)}>
      <div className="w-full max-w-xl">
        <h2 className="text-sm font-semibold text-ink">New thread</h2>
        <p className="mt-1 text-xs leading-relaxed text-ink-muted">
          One conversation with one agent. It runs as a native interactive session in the
          terminal panel; flip on worktree isolation for a headless run whose changes you merge
          back from the thread.
        </p>
        <Textarea
          autoFocus
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={onKeydown}
          rows={5}
          placeholder={`What should the agent do? (${sendHint})`}
          aria-label="New thread prompt"
          className="mt-3"
        />
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-1.5 text-xs text-ink-muted">
            Agent
            <Select
              value={agentId}
              onChange={(e) => setAgentId(e.target.value)}
              aria-label="Agent profile"
              size="sm"
              className="w-44"
            >
              <option value="">Default{roster?.defaultAgentId ? "" : " (none)"}</option>
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                  {agent.model !== AUTO_MODEL ? ` · ${agent.model}` : ""}
                </option>
              ))}
            </Select>
          </label>
          <label className="flex items-center gap-1.5 text-xs text-ink-muted">
            Model
            <input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder={profile?.model && profile.model !== AUTO_MODEL ? profile.model : "default"}
              aria-label="Model override"
              className="h-7 w-28 rounded-md border border-edge bg-surface-1 px-2 text-xs text-ink placeholder:text-ink-faint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-crystal-400/60"
            />
          </label>
          <label className="flex items-center gap-1.5 text-xs text-ink-muted">
            <Switch checked={worktree} onChange={setWorktree} aria-label="Isolate in a git worktree" />
            Isolate in a git worktree
          </label>
          <div className="flex-1" />
          <Button variant="primary" size="sm" disabled={busy || !prompt.trim()} onClick={() => void dispatch()}>
            <Send className="h-3 w-3" /> Start
          </Button>
        </div>
        {error ? <p className="mt-2 text-xs text-danger">{error}</p> : null}
      </div>
    </div>
  );
}

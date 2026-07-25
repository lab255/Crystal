import { useEffect, useState } from "react";
import { Layers, Rocket, Target } from "lucide-react";
import { headline } from "@crystal/core";
import { EMPTY_HUB_PROJECTS, EMPTY_HUB_RECENTS, useHub, useNav } from "@crystal/client";
import { Button, EmptyState, Input, Textarea } from "@crystal/ui";
import { SegmentedTab, TabStrip, parseBudget } from "./common.js";
import { ProjectSelect } from "./ProjectSelect.js";

/**
 * The Hub's landing panel: start work. Two shapes, because the two cases are
 * genuinely different — one project gets an epic handed straight to its
 * orchestrator; several projects get a program whose deliveries are sequenced
 * against each other.
 */
export function NewProgramPanel({ onStarted }: { onStarted: (programId: string) => void }) {
  const [mode, setMode] = useState<"epic" | "program">("epic");

  return (
    <div className="mx-auto flex h-full w-full max-w-2xl flex-col gap-4 overflow-y-auto p-5">
      <TabStrip className="self-start">
        <SegmentedTab active={mode === "epic"} onClick={() => setMode("epic")}>
          <Rocket className="h-3.5 w-3.5" /> Dispatch an epic
        </SegmentedTab>
        <SegmentedTab active={mode === "program"} onClick={() => setMode("program")}>
          <Layers className="h-3.5 w-3.5" /> Multi-project program
        </SegmentedTab>
      </TabStrip>

      {mode === "epic" ? <EpicForm onStarted={onStarted} /> : <ProgramForm onStarted={onStarted} />}

      <EmptyState icon={Target} title="Programs sit above projects">
        A program is one high-level goal split into per-project deliveries. Dispatching a delivery
        starts a workflow inside that project, and its own orchestrator runs the full development
        flow there — refine, plan and design, develop and review on parallel branches, merge,
        release. The Hub only decides what each project is asked for, in what order, and against
        what budget. The same surface is available to an external agent over MCP.
      </EmptyState>
    </div>
  );
}


/** One project, one goal, dispatched immediately — the common case. */
function EpicForm({ onStarted }: { onStarted: (programId: string) => void }) {
  const dispatchEpic = useHub((s) => s.dispatchEpic);
  const projects = useHub((s) => s.projects) ?? EMPTY_HUB_PROJECTS;
  const recents = useHub((s) => s.recents) ?? EMPTY_HUB_RECENTS;

  // The project to dispatch into, if the user arrived from a project card.
  const wantedWs = useNav((l) => l.hub?.project) ?? null;
  const [root, setRoot] = useState("");
  // The store is empty on the first render (the Hub kicks off its refresh on
  // mount), so seeding this in `useState` would silently never apply.
  useEffect(() => {
    if (root) return;
    const wanted = wantedWs ? projects.find((p) => p.ws === wantedWs) : null;
    const next = wanted ?? projects[0];
    if (next) setRoot(next.root);
  }, [root, wantedWs, projects]);
  const [name, setName] = useState("");
  const [goal, setGoal] = useState("");
  const [budget, setBudget] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!root || !goal.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const program = await dispatchEpic({
        projectRoot: root,
        name: name.trim() || headline(goal, 60) || "Epic",
        goal: goal.trim(),
        budgetUsd: parseBudget(budget),
      });
      onStarted(program.id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="rounded-xl border border-crystal-500/25 bg-crystal-500/5 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="mb-2 flex items-center gap-2">
        <Rocket className="h-4 w-4 text-crystal-300" />
        <span className="text-[13px] font-semibold text-ink">
          Hand an epic to one project's orchestrator
        </span>
      </div>
      <ProjectSelect
        value={root}
        onChange={setRoot}
        projects={projects}
        recents={recents}
        aria-label="Project to dispatch into"
      />
      <Textarea
        value={goal}
        onChange={(e) => setGoal(e.target.value)}
        rows={5}
        placeholder="What the project must deliver, as an outcome with acceptance criteria. Its orchestrator refines this with you before planning — rough is fine."
        aria-label="Epic goal"
        className="mt-2"
      />
      <div className="mt-2 flex items-center gap-2">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Name (defaults to the first line)"
          aria-label="Program name"
          className="flex-1"
        />
        <Input
          value={budget}
          onChange={(e) => setBudget(e.target.value)}
          placeholder="Budget USD"
          aria-label="Budget in USD"
          className="w-32"
        />
        <Button type="submit" variant="primary" size="sm" disabled={busy || !root || !goal.trim()}>
          <Rocket className="h-3 w-3" /> Dispatch
        </Button>
      </div>
      {error ? <p className="mt-2 text-[11px] text-danger">{error}</p> : null}
    </form>
  );
}

/** Several projects, sequenced — created empty, then deliveries are added. */
function ProgramForm({ onStarted }: { onStarted: (programId: string) => void }) {
  const createProgram = useHub((s) => s.createProgram);
  const [name, setName] = useState("");
  const [goal, setGoal] = useState("");
  const [budget, setBudget] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!name.trim() || !goal.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const program = await createProgram({
        name: name.trim(),
        goal: goal.trim(),
        budgetUsd: parseBudget(budget),
      });
      onStarted(program.id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="rounded-xl border border-crystal-500/25 bg-crystal-500/5 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="mb-2 flex items-center gap-2">
        <Layers className="h-4 w-4 text-crystal-300" />
        <span className="text-[13px] font-semibold text-ink">
          One goal, several projects
        </span>
      </div>
      <Input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Program name, e.g. SSO everywhere"
        aria-label="Program name"
      />
      <Textarea
        value={goal}
        onChange={(e) => setGoal(e.target.value)}
        rows={5}
        placeholder="The cross-project epic in full. You (or a program manager session) split it into one delivery per project next."
        aria-label="Program goal"
        className="mt-2"
      />
      <div className="mt-2 flex items-center gap-2">
        <Input
          value={budget}
          onChange={(e) => setBudget(e.target.value)}
          placeholder="Budget USD across all projects"
          aria-label="Program budget in USD"
          className="w-56"
        />
        <Button
          type="submit"
          variant="primary"
          size="sm"
          className="ml-auto"
          disabled={busy || !name.trim() || !goal.trim()}
        >
          Create program
        </Button>
      </div>
      {error ? <p className="mt-2 text-[11px] text-danger">{error}</p> : null}
    </form>
  );
}

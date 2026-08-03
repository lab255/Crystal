import { useEffect, useState } from "react";
import { Plus } from "lucide-react";
import type { Program } from "@crystal/core";
import { EMPTY_HUB_PROJECTS, EMPTY_HUB_RECENTS, useComposerKeydown, useHub } from "@crystal/client";
import { Button, Input, Textarea, cn } from "@crystal/ui";
import { parseBudget } from "./common.js";
import { ProjectSelect } from "./ProjectSelect.js";

/**
 * Add one project's share of a program. Dependencies are picked from the
 * program's existing deliveries — that is the whole cross-project sequencing
 * model: a delivery starts itself once everything it depends on has completed.
 */
export function AddDeliveryForm({
  program,
  onDone,
  className,
}: {
  program: Program;
  onDone: () => void;
  className?: string;
}) {
  const addDelivery = useHub((s) => s.addDelivery);
  const projects = useHub((s) => s.projects) ?? EMPTY_HUB_PROJECTS;
  const recents = useHub((s) => s.recents) ?? EMPTY_HUB_RECENTS;

  const [root, setRoot] = useState(projects[0]?.root ?? "");
  useEffect(() => {
    if (!root && projects[0]) setRoot(projects[0].root);
  }, [root, projects]);
  const [brief, setBrief] = useState("");
  const onComposerKey = useComposerKeydown(() => void submit());
  const [budget, setBudget] = useState("");
  const [runCap, setRunCap] = useState("");
  const [dependsOn, setDependsOn] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!root || !brief.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await addDelivery({
        programId: program.id,
        projectRoot: root,
        brief: brief.trim(),
        dependsOn,
        budgetUsd: parseBudget(budget),
        runCapUsd: parseBudget(runCap),
      });
      setBrief("");
      setDependsOn([]);
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className={cn("rounded-xl border border-crystal-500/25 bg-crystal-500/5 p-3", className)}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <ProjectSelect
        value={root}
        onChange={setRoot}
        projects={projects}
        recents={recents}
        aria-label="Project for this delivery"
      />
      <Textarea
        value={brief}
        onChange={(e) => setBrief(e.target.value)}
        onKeyDown={onComposerKey}
        rows={4}
        placeholder="What this project must deliver — outcomes and acceptance criteria, not implementation steps. Its own orchestrator refines and plans against this."
        aria-label="Delivery brief"
        className="mt-2"
      />
      {program.deliveries.length > 0 ? (
        <div className="mt-2">
          <span className="text-[10px] uppercase tracking-wider text-ink-faint">
            Starts only after
          </span>
          <div className="mt-1 flex flex-wrap gap-1">
            {program.deliveries.map((d) => {
              const on = dependsOn.includes(d.id);
              return (
                <button
                  key={d.id}
                  type="button"
                  onClick={() =>
                    setDependsOn((cur) =>
                      on ? cur.filter((id) => id !== d.id) : [...cur, d.id],
                    )
                  }
                  className={cn(
                    "rounded-full border px-2 py-0.5 text-[10px]",
                    on
                      ? "border-crystal-500/50 bg-crystal-500/15 text-crystal-200"
                      : "border-edge text-ink-muted hover:text-ink",
                  )}
                >
                  {d.projectName}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
      <div className="mt-2 flex items-center gap-2">
        <Input
          value={budget}
          onChange={(e) => setBudget(e.target.value)}
          placeholder="Budget USD (optional)"
          aria-label="Delivery budget in USD"
          className="w-44"
        />
        <Input
          value={runCap}
          onChange={(e) => setRunCap(e.target.value)}
          placeholder="$/run cap"
          aria-label="Per-run cost cap in USD"
          title="Per-run cost cap for the delivery's workflow — any single run crossing it is killed mid-flight."
          className="w-24"
        />
        <Button variant="ghost" size="sm" onClick={onDone} type="button">
          Cancel
        </Button>
        <Button
          type="submit"
          variant="primary"
          size="sm"
          className="ml-auto"
          disabled={busy || !root || !brief.trim()}
        >
          <Plus className="h-3 w-3" /> Add delivery
        </Button>
      </div>
      {error ? <p className="mt-2 text-[11px] text-danger">{error}</p> : null}
    </form>
  );
}

import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Check,
  Copy,
  LayoutTemplate,
  Lock,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import {
  RUN_PURPOSES,
  duplicateTemplate,
  isCustomTemplateId,
  validateWorkflowTemplate,
  type RunPurpose,
  type WorkflowStageDef,
  type WorkflowTemplate,
} from "@crystal/core";
import { useWorkflows } from "@crystal/client";
import { Badge, Button, EmptyState, Input, Textarea, Tooltip, cn } from "@crystal/ui";
import { WorkflowGraph } from "./WorkflowGraph.js";

/**
 * The visual workflow builder: author custom templates as a stage graph.
 * Left: every selectable template (built-ins are read-only — duplicate to
 * edit). Center: the react-flow canvas — drag stages, draw dependency edges,
 * delete with Backspace. Right: the inspector for the selected stage.
 * Custom templates persist server-side; running workflows are unaffected
 * (each snapshots its template at start).
 */
export function TemplateBuilder({
  selectedTemplateId,
  onSelectTemplate,
  onClose,
}: {
  selectedTemplateId: string | null;
  onSelectTemplate: (id: string | null) => void;
  onClose: () => void;
}) {
  const templates = useWorkflows((s) => s.templates);
  const saveTemplate = useWorkflows((s) => s.saveTemplate);
  const deleteTemplate = useWorkflows((s) => s.deleteTemplate);

  const selected = templates.find((t) => t.id === selectedTemplateId) ?? templates[0] ?? null;
  const editable = selected != null && isCustomTemplateId(selected.id);

  // The working copy of a custom template; null while a built-in is viewed.
  const [draft, setDraft] = useState<WorkflowTemplate | null>(null);
  const [dirty, setDirty] = useState(false);
  const [stageId, setStageId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(
      selected && isCustomTemplateId(selected.id)
        ? { ...selected, stages: selected.stages.map((s) => ({ ...s, dependsOn: [...s.dependsOn] })) }
        : null,
    );
    setDirty(false);
    setStageId(null);
    setError(null);
  }, [selected?.id]);

  const view = draft ?? selected;
  const problems = useMemo(() => (draft ? validateWorkflowTemplate(draft) : []), [draft]);
  const stage = view?.stages.find((s) => s.id === stageId) ?? null;

  const mutate = (fn: (t: WorkflowTemplate) => WorkflowTemplate) => {
    setDraft((d) => (d ? fn(d) : d));
    setDirty(true);
  };
  const mutateStage = (id: string, patch: Partial<WorkflowStageDef>) =>
    mutate((t) => ({
      ...t,
      stages: t.stages.map((s) => (s.id === id ? { ...s, ...patch } : s)),
    }));

  const addStage = () =>
    mutate((t) => {
      let n = t.stages.length + 1;
      while (t.stages.some((s) => s.id === `stage-${n}`)) n += 1;
      const id = `stage-${n}`;
      setStageId(id);
      return {
        ...t,
        stages: [
          ...t.stages,
          { id, name: "New stage", purpose: "implement" as RunPurpose, dependsOn: [], perTrack: false, description: "" },
        ],
      };
    });

  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const duplicate = (base: WorkflowTemplate) =>
    run(async () => {
      const copy = await saveTemplate(duplicateTemplate(base));
      onSelectTemplate(copy.id);
    });

  return (
    <div className="flex h-full min-h-0">
      {/* Template list */}
      <aside className="flex w-56 shrink-0 flex-col border-r border-edge bg-surface-1">
        <div className="flex items-center gap-2 border-b border-edge px-3 py-2">
          <LayoutTemplate className="h-3.5 w-3.5 text-crystal-300" />
          <span className="text-xs font-semibold text-ink">Templates</span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {templates.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => onSelectTemplate(t.id)}
              className={cn(
                "mb-1 block w-full rounded-lg border px-2.5 py-2 text-left transition-colors",
                t.id === view?.id
                  ? "border-crystal-500/40 bg-crystal-500/10"
                  : "border-transparent hover:border-edge hover:bg-surface-2",
              )}
            >
              <div className="flex items-center gap-1.5">
                <span className="min-w-0 flex-1 truncate text-xs font-medium text-ink">
                  {t.name}
                </span>
                {isCustomTemplateId(t.id) ? null : (
                  <Tooltip content="Built-in — duplicate to edit">
                    <Lock className="h-3 w-3 shrink-0 text-ink-faint" />
                  </Tooltip>
                )}
              </div>
              <span className="text-[10px] text-ink-faint">
                {t.stages.length} stage{t.stages.length === 1 ? "" : "s"}
              </span>
            </button>
          ))}
        </div>
      </aside>

      {/* Canvas + header */}
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-2 border-b border-edge px-3 py-2">
          {draft ? (
            <Input
              value={draft.name}
              onChange={(e) => mutate((t) => ({ ...t, name: e.target.value }))}
              aria-label="Template name"
              className="h-7 w-64 text-[13px] font-semibold"
            />
          ) : (
            <span className="flex items-center gap-2 text-[13px] font-semibold text-ink">
              {view?.name ?? "Templates"}
              {view && !editable ? <Badge tone="slate">built-in</Badge> : null}
            </span>
          )}
          <div className="ml-auto flex items-center gap-1.5">
            {draft ? (
              <>
                <Button variant="ghost" size="xs" onClick={addStage}>
                  <Plus className="h-3 w-3" /> Add stage
                </Button>
                <Button
                  variant="primary"
                  size="xs"
                  disabled={busy || !dirty || problems.length > 0}
                  onClick={() =>
                    void run(async () => {
                      const saved = await saveTemplate(draft);
                      setDirty(false);
                      if (saved.id !== selected?.id) onSelectTemplate(saved.id);
                    })
                  }
                >
                  <Check className="h-3 w-3" /> Save
                </Button>
                <Button
                  variant="danger"
                  size="xs"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await deleteTemplate(draft.id);
                      onSelectTemplate(null);
                    })
                  }
                >
                  <Trash2 className="h-3 w-3" /> Delete
                </Button>
              </>
            ) : view ? (
              <Button variant="ghost" size="xs" disabled={busy} onClick={() => void duplicate(view)}>
                <Copy className="h-3 w-3" /> Duplicate to edit
              </Button>
            ) : null}
            <Button variant="ghost" size="xs" onClick={onClose} aria-label="Close builder">
              <X className="h-3.5 w-3.5" /> Done
            </Button>
          </div>
        </header>

        {problems.length > 0 || error ? (
          <div className="flex items-start gap-2 border-b border-warn/30 bg-warn/10 px-3 py-1.5 text-[11px] text-warn">
            <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
            <span>{error ?? problems.join(" ")}</span>
          </div>
        ) : null}

        <div className="min-h-0 flex-1">
          {view ? (
            <WorkflowGraph
              key={view.id}
              stages={view.stages}
              editable={draft != null}
              selectedStageId={stageId}
              onSelectStage={setStageId}
              onConnectDep={(from, to) =>
                mutate((t) => ({
                  ...t,
                  stages: t.stages.map((s) =>
                    s.id === to && !s.dependsOn.includes(from)
                      ? { ...s, dependsOn: [...s.dependsOn, from] }
                      : s,
                  ),
                }))
              }
              onRemoveDeps={(deps) =>
                mutate((t) => ({
                  ...t,
                  stages: t.stages.map((s) => {
                    const drop = deps.filter((d) => d.to === s.id).map((d) => d.from);
                    return drop.length
                      ? { ...s, dependsOn: s.dependsOn.filter((dep) => !drop.includes(dep)) }
                      : s;
                  }),
                }))
              }
              onRemoveStages={(ids) => {
                if (stageId && ids.includes(stageId)) setStageId(null);
                mutate((t) => ({
                  ...t,
                  stages: t.stages
                    .filter((s) => !ids.includes(s.id))
                    .map((s) => ({ ...s, dependsOn: s.dependsOn.filter((d) => !ids.includes(d)) })),
                }));
              }}
            />
          ) : (
            <EmptyState icon={LayoutTemplate} title="No templates" />
          )}
        </div>
        {draft ? (
          <p className="border-t border-edge px-3 py-1 text-[10px] text-ink-faint">
            Drag between handles to add a dependency · select an edge or stage and press
            Backspace to remove it
          </p>
        ) : null}
      </main>

      {/* Stage inspector */}
      {stage && view ? (
        <aside className="flex w-72 shrink-0 flex-col overflow-y-auto border-l border-edge bg-surface-1 p-3">
          <div className="mb-2 flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-xs font-semibold text-ink">
              {stage.name || stage.id}
            </span>
            <span className="font-mono text-[10px] text-ink-faint">{stage.id}</span>
          </div>
          {draft ? (
            <div className="space-y-3">
              <Field label="Name">
                <Input
                  value={stage.name}
                  onChange={(e) => mutateStage(stage.id, { name: e.target.value })}
                  aria-label="Stage name"
                  className="h-7 text-xs"
                />
              </Field>
              <Field label="Worker purpose">
                <select
                  className="h-7 w-full rounded-lg border border-edge bg-surface-1 px-2 text-xs text-ink focus:border-crystal-500/60 focus:outline-none"
                  value={stage.purpose}
                  onChange={(e) => mutateStage(stage.id, { purpose: e.target.value as RunPurpose })}
                  aria-label="Stage purpose"
                >
                  {RUN_PURPOSES.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Model" hint="Cost routing — heavyweight only where code gets written">
                <Input
                  value={stage.model ?? ""}
                  onChange={(e) =>
                    mutateStage(stage.id, { model: e.target.value.trim() || undefined })
                  }
                  placeholder="CLI default"
                  list="wf-builder-models"
                  aria-label="Stage model"
                  className="h-7 text-xs"
                />
                <datalist id="wf-builder-models">
                  <option value="opus" />
                  <option value="sonnet" />
                  <option value="haiku" />
                </datalist>
              </Field>
              <label className="flex items-center gap-2 text-xs text-ink">
                <input
                  type="checkbox"
                  checked={stage.perTrack}
                  onChange={(e) => mutateStage(stage.id, { perTrack: e.target.checked })}
                />
                Runs once per parallel track
              </label>
              <Field label="Description" hint="Woven into the manager's prompt">
                <Textarea
                  value={stage.description}
                  onChange={(e) => mutateStage(stage.id, { description: e.target.value })}
                  rows={4}
                  aria-label="Stage description"
                  className="text-xs"
                />
              </Field>
              <Field label="Depends on">
                <span className="text-[11px] text-ink-muted">
                  {stage.dependsOn.length
                    ? stage.dependsOn.join(", ")
                    : "Nothing — starts immediately"}
                </span>
              </Field>
            </div>
          ) : (
            <div className="space-y-2 text-[11px] text-ink-muted">
              <p>{stage.description || "No description."}</p>
              <p>
                Purpose <span className="font-mono text-ink">{stage.purpose}</span>
                {stage.model ? (
                  <>
                    {" "}
                    · model <span className="font-mono text-ink">{stage.model}</span>
                  </>
                ) : null}
                {stage.perTrack ? " · per track" : null}
              </p>
              <p>
                Depends on:{" "}
                {stage.dependsOn.length ? stage.dependsOn.join(", ") : "nothing"}
              </p>
            </div>
          )}
        </aside>
      ) : null}
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-ink-faint">
        {label}
      </div>
      {children}
      {hint ? <p className="mt-1 text-[10px] text-ink-faint">{hint}</p> : null}
    </div>
  );
}

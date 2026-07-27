import { useMemo, useState } from "react";
import { AlertTriangle, GripVertical, Info } from "lucide-react";
import {
  RUN_PURPOSES,
  STAGE_ARCHETYPES,
  TASK_STATUSES,
  TASK_STATUS_LABELS,
  stageFromArchetype,
  templateWarnings,
  validateWorkflowTemplate,
  type RunPurpose,
  type StageArchetype,
  type TaskStatus,
  type WorkflowStageDef,
  type WorkflowTemplate,
} from "@crystal/core";
import { Badge, Input, Textarea, Tooltip, cn } from "@crystal/ui";
import { STAGE_DND_MIME, WorkflowGraph } from "./WorkflowGraph.js";

/**
 * Editing one stage graph: palette on the left, canvas in the middle,
 * stage inspector on the right.
 *
 * Deliberately value-in/value-out and unaware of persistence, because the
 * same editing surface serves two very different jobs — authoring a template
 * in the library, and tweaking one workflow's graph in the start panel
 * (where the result is snapshotted into that run and never saved anywhere).
 * Whoever owns the value decides what happens to it.
 */
export function TemplateEditor({
  template,
  onChange,
  readOnly = false,
  selectedStageId,
  onSelectStage,
  footer,
  className,
}: {
  template: WorkflowTemplate;
  /** Omitted or `readOnly` — the canvas renders, nothing can be edited. */
  onChange?: (next: WorkflowTemplate) => void;
  readOnly?: boolean;
  selectedStageId?: string | null;
  onSelectStage?: (id: string | null) => void;
  /** Extra content under the canvas (the builder puts its hint line here). */
  footer?: React.ReactNode;
  className?: string;
}) {
  const editable = !readOnly && onChange != null;
  const [internalStageId, setInternalStageId] = useState<string | null>(null);
  const stageId = selectedStageId !== undefined ? selectedStageId : internalStageId;
  const selectStage = onSelectStage ?? setInternalStageId;

  const problems = useMemo(() => validateWorkflowTemplate(template), [template]);
  const warnings = useMemo(
    () => (problems.length ? [] : templateWarnings(template)),
    [template, problems.length],
  );
  const stage = template.stages.find((s) => s.id === stageId) ?? null;

  const mutate = (fn: (t: WorkflowTemplate) => WorkflowTemplate) => {
    if (editable) onChange!(fn(template));
  };
  const mutateStage = (id: string, patch: Partial<WorkflowStageDef>) =>
    mutate((t) => ({
      ...t,
      stages: t.stages.map((s) => (s.id === id ? { ...s, ...patch } : s)),
    }));

  const dropArchetype = (key: string, position: { x: number; y: number }) => {
    const archetype = STAGE_ARCHETYPES.find((a) => a.key === key);
    if (!archetype) return;
    const stages = template.stages;
    const created = stageFromArchetype(
      archetype,
      stages.map((s) => s.id),
      position,
    );
    mutate((t) => ({ ...t, stages: [...t.stages, created] }));
    selectStage(created.id);
  };

  return (
    <div className={cn("flex h-full min-h-0", className)}>
      {editable ? <StagePalette /> : null}

      <div className="flex min-w-0 flex-1 flex-col">
        {problems.length || warnings.length ? (
          <div
            className={cn(
              "flex items-start gap-2 border-b px-3 py-1.5 text-[11px]",
              problems.length
                ? "border-danger/30 bg-danger/10 text-danger"
                : "border-warn/30 bg-warn/10 text-warn",
            )}
          >
            {problems.length ? (
              <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
            ) : (
              <Info className="mt-px h-3.5 w-3.5 shrink-0" />
            )}
            <span>{(problems.length ? problems : warnings).join(" ")}</span>
          </div>
        ) : null}

        <div className="min-h-0 flex-1">
          <WorkflowGraph
            stages={template.stages}
            editable={editable}
            selectedStageId={stageId}
            onSelectStage={selectStage}
            onMoveStage={(id, position) => mutateStage(id, { x: position.x, y: position.y })}
            onDropStage={dropArchetype}
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
              if (stageId && ids.includes(stageId)) selectStage(null);
              mutate((t) => ({
                ...t,
                stages: t.stages
                  .filter((s) => !ids.includes(s.id))
                  .map((s) => ({ ...s, dependsOn: s.dependsOn.filter((d) => !ids.includes(d)) })),
              }));
            }}
          />
        </div>
        {footer}
      </div>

      {stage ? (
        <StageInspector
          stage={stage}
          template={template}
          editable={editable}
          onPatch={(patch) => mutateStage(stage.id, patch)}
        />
      ) : null}
    </div>
  );
}

/**
 * The stage palette. Entries are dragged onto the canvas rather than clicked,
 * so where a stage lands is the user's choice — which is the whole point of
 * persisting positions.
 */
function StagePalette() {
  return (
    <aside className="flex w-44 shrink-0 flex-col border-r border-edge bg-surface-1">
      <div className="border-b border-edge px-3 py-2">
        <div className="text-xs font-semibold text-ink">Stages</div>
        <p className="mt-0.5 text-[10px] leading-snug text-ink-faint">
          Drag onto the canvas, then draw arrows between handles to set the order.
        </p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {STAGE_ARCHETYPES.map((archetype) => (
          <PaletteEntry key={archetype.key} archetype={archetype} />
        ))}
      </div>
    </aside>
  );
}

function PaletteEntry({ archetype }: { archetype: StageArchetype }) {
  return (
    <Tooltip content={archetype.description}>
      <div
        draggable
        onDragStart={(event) => {
          event.dataTransfer.setData(STAGE_DND_MIME, archetype.key);
          event.dataTransfer.effectAllowed = "copy";
        }}
        className="mb-1 flex cursor-grab items-center gap-1.5 rounded-lg border border-transparent px-2 py-1.5 hover:border-edge hover:bg-surface-2 active:cursor-grabbing"
      >
        <GripVertical className="h-3 w-3 shrink-0 text-ink-faint" />
        <span className="min-w-0 flex-1 truncate text-xs text-ink">{archetype.name}</span>
        <span className="shrink-0 font-mono text-[9px] text-ink-faint">{archetype.purpose}</span>
      </div>
    </Tooltip>
  );
}

function StageInspector({
  stage,
  template,
  editable,
  onPatch,
}: {
  stage: WorkflowStageDef;
  template: WorkflowTemplate;
  editable: boolean;
  onPatch: (patch: Partial<WorkflowStageDef>) => void;
}) {
  // What this stage is handed, read off its dependencies — the inspector's
  // job is to make one stage's contract legible without reading the canvas.
  const receives = stage.dependsOn
    .map((dep) => template.stages.find((s) => s.id === dep))
    .filter((dep): dep is WorkflowStageDef => dep != null);

  return (
    <aside className="flex w-72 shrink-0 flex-col overflow-y-auto border-l border-edge bg-surface-1 p-3">
      <div className="mb-2 flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-ink">
          {stage.name || stage.id}
        </span>
        <span className="font-mono text-[10px] text-ink-faint">{stage.id}</span>
      </div>

      {editable ? (
        <div className="space-y-3">
          <Field label="Name">
            <Input
              value={stage.name}
              onChange={(e) => onPatch({ name: e.target.value })}
              aria-label="Stage name"
              className="h-7 text-xs"
            />
          </Field>
          <Field label="Worker purpose">
            <select
              className="h-7 w-full rounded-lg border border-edge bg-surface-1 px-2 text-xs text-ink focus:border-crystal-500/60 focus:outline-none"
              value={stage.purpose}
              onChange={(e) => onPatch({ purpose: e.target.value as RunPurpose })}
              aria-label="Stage purpose"
            >
              {RUN_PURPOSES.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </Field>
          <Field
            label="Board column"
            hint="Where this stage's tasks sit on the orchestrator board while it works"
          >
            <select
              className="h-7 w-full rounded-lg border border-edge bg-surface-1 px-2 text-xs text-ink focus:border-crystal-500/60 focus:outline-none"
              value={stage.boardStatus ?? ""}
              onChange={(e) =>
                onPatch({ boardStatus: (e.target.value || null) as TaskStatus | null })
              }
              aria-label="Stage board column"
            >
              <option value="">None — coordination only</option>
              {TASK_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {TASK_STATUS_LABELS[s]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Model" hint="Cost routing — heavyweight only where code gets written">
            <Input
              value={stage.model ?? ""}
              onChange={(e) => onPatch({ model: e.target.value.trim() || undefined })}
              placeholder="CLI default"
              list="wf-builder-models"
              aria-label="Stage model"
              className="h-7 text-xs"
            />
            <datalist id="wf-builder-models">
              <option value="fable" />
              <option value="opus" />
              <option value="sonnet" />
              <option value="haiku" />
            </datalist>
          </Field>
          <label className="flex items-center gap-2 text-xs text-ink">
            <input
              type="checkbox"
              checked={stage.perTrack}
              onChange={(e) => onPatch({ perTrack: e.target.checked })}
            />
            Runs once per parallel track
          </label>
          <Field label="Description" hint="Woven into the manager's prompt">
            <Textarea
              value={stage.description}
              onChange={(e) => onPatch({ description: e.target.value })}
              rows={3}
              aria-label="Stage description"
              className="text-xs"
            />
          </Field>
          <Field
            label="Hands off"
            hint="The artifact the next stage is owed — stated concretely"
          >
            <Textarea
              value={stage.handoff}
              onChange={(e) => onPatch({ handoff: e.target.value })}
              rows={3}
              aria-label="Stage handoff"
              className="text-xs"
            />
          </Field>
        </div>
      ) : (
        <div className="space-y-2 text-[11px] text-ink-muted">
          <p>{stage.description || "No description."}</p>
          {stage.handoff ? (
            <p>
              <span className="text-ink-faint">Hands off: </span>
              {stage.handoff}
            </p>
          ) : null}
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
          {stage.boardStatus ? (
            <p>
              Board column <Badge tone="slate">{TASK_STATUS_LABELS[stage.boardStatus]}</Badge>
            </p>
          ) : null}
        </div>
      )}

      <div className="mt-3 border-t border-edge pt-2">
        <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-ink-faint">
          Receives
        </div>
        {receives.length ? (
          <ul className="space-y-1.5">
            {receives.map((dep) => (
              <li key={dep.id} className="text-[11px] leading-snug">
                <span className="font-mono text-ink">{dep.id}</span>
                <span className="text-ink-muted">
                  {" — "}
                  {dep.handoff || "hands off nothing in particular"}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[11px] text-ink-muted">Nothing — this stage starts immediately.</p>
        )}
      </div>
    </aside>
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

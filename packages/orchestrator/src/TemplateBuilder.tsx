import { useEffect, useMemo, useState } from "react";
import {
  Check,
  Copy,
  FolderDown,
  Globe,
  LayoutTemplate,
  Lock,
  Trash2,
  X,
} from "lucide-react";
import {
  deriveTemplate,
  isEditableTemplate,
  templateScope,
  validateWorkflowTemplate,
  type TemplateScope,
  type WorkflowTemplate,
} from "@crystal/core";
import { useWorkflows } from "@crystal/client";
import { Badge, Button, EmptyState, Tooltip, cn } from "@crystal/ui";
import { TemplateEditor } from "./TemplateEditor.js";

/**
 * The visual workflow builder: author templates as a stage graph.
 *
 * Left: the library in three groups — built-in (read-only), the shared
 * **global** templates every project on this machine can start from, and this
 * **project's** own. Center/right: the shared {@link TemplateEditor} (palette,
 * canvas, stage inspector).
 *
 * Editing never disturbs a running workflow — each snapshots its template at
 * start — and deriving is always a full copy, so customising a library
 * template for one project cannot reach back into the library.
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
  const editable = selected != null && isEditableTemplate(selected);

  // The working copy of an editable template; null while a built-in is viewed.
  const [draft, setDraft] = useState<WorkflowTemplate | null>(null);
  const [dirty, setDirty] = useState(false);
  const [stageId, setStageId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(
      selected && isEditableTemplate(selected)
        ? { ...selected, stages: selected.stages.map((s) => ({ ...s, dependsOn: [...s.dependsOn] })) }
        : null,
    );
    setDirty(false);
    setStageId(null);
    setError(null);
  }, [selected?.id]);

  const view = draft ?? selected;
  const problems = useMemo(() => (draft ? validateWorkflowTemplate(draft) : []), [draft]);
  const groups = useMemo(() => groupByScope(templates), [templates]);

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

  const derive = (base: WorkflowTemplate, scope: Exclude<TemplateScope, "builtin">) =>
    run(async () => {
      const copy = await saveTemplate(deriveTemplate(base, { scope }), scope);
      onSelectTemplate(copy.id);
    });

  const scopeOf = draft ? templateScope(draft) : null;

  function confirmDiscard(): boolean {
    return !dirty || window.confirm("Discard unsaved template edits?");
  }

  function selectTemplate(id: string): void {
    if (id === view?.id || !confirmDiscard()) return;
    onSelectTemplate(id);
  }

  function close(): void {
    if (confirmDiscard()) onClose();
  }

  return (
    <div className="flex h-full min-h-0">
      {/* Library */}
      <aside className="flex w-56 shrink-0 flex-col border-r border-edge bg-surface-1">
        <div className="flex items-center gap-2 border-b border-edge px-3 py-2">
          <LayoutTemplate className="h-3.5 w-3.5 text-crystal-300" />
          <span className="text-xs font-semibold text-ink">Templates</span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {SCOPE_ORDER.map((scope) =>
            groups[scope].length ? (
              <section key={scope} className="mb-2">
                <div className="px-1.5 py-1 text-[10px] font-medium uppercase tracking-wider text-ink-faint">
                  {SCOPE_LABELS[scope]}
                </div>
                {groups[scope].map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => selectTemplate(t.id)}
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
                      {scope === "builtin" ? (
                        <Tooltip content="Built-in — derive a copy to edit">
                          <Lock className="h-3 w-3 shrink-0 text-ink-faint" />
                        </Tooltip>
                      ) : scope === "global" ? (
                        <Tooltip content="Shared with every project on this machine">
                          <Globe className="h-3 w-3 shrink-0 text-ink-faint" />
                        </Tooltip>
                      ) : null}
                    </div>
                    <span className="text-[10px] text-ink-faint">
                      {t.stages.length} stage{t.stages.length === 1 ? "" : "s"}
                    </span>
                  </button>
                ))}
              </section>
            ) : null,
          )}
        </div>
      </aside>

      {/* Editor */}
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-2 border-b border-edge px-3 py-2">
          <span className="flex min-w-0 items-center gap-2 text-[13px] font-semibold text-ink">
            <span className="truncate">{view?.name ?? "Templates"}</span>
            {view && !editable ? <Badge tone="slate">built-in</Badge> : null}
          </span>

          <div className="ml-auto flex items-center gap-1.5">
            {draft ? (
              <>
                {/* Scope, as one concept: a template lives in exactly one of
                    built-in / library / this project, and moving it is a save
                    with a different target directory — so the two writable
                    scopes read as a labeled pair, not scattered actions. */}
                <div className="mr-1 flex items-center gap-1 rounded-lg border border-edge px-1 py-0.5">
                  <span className="px-1 text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
                    Scope
                  </span>
                  <Tooltip content="Pinned to this project only">
                    <Button
                      variant="ghost"
                      size="xs"
                      disabled={busy}
                      className={cn(scopeOf === "project" && "bg-surface-3 text-ink")}
                      onClick={() => {
                        if (scopeOf === "project") return;
                        void run(async () => {
                          const saved = await saveTemplate(draft, "project");
                          setDirty(false);
                          onSelectTemplate(saved.id);
                        });
                      }}
                    >
                      <FolderDown className="h-3 w-3" /> This project
                    </Button>
                  </Tooltip>
                  <Tooltip content="Shared library — visible from every project on this machine">
                    <Button
                      variant="ghost"
                      size="xs"
                      disabled={busy}
                      className={cn(scopeOf === "global" && "bg-surface-3 text-ink")}
                      onClick={() => {
                        if (scopeOf === "global") return;
                        void run(async () => {
                          const saved = await saveTemplate(draft, "global");
                          setDirty(false);
                          onSelectTemplate(saved.id);
                        });
                      }}
                    >
                      <Globe className="h-3 w-3" /> All projects
                    </Button>
                  </Tooltip>
                </div>
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
              <>
                <Button
                  variant="ghost"
                  size="xs"
                  disabled={busy}
                  onClick={() => void derive(view, "project")}
                >
                  <FolderDown className="h-3 w-3" /> Customise for this project
                </Button>
                <Button
                  variant="ghost"
                  size="xs"
                  disabled={busy}
                  onClick={() => void derive(view, "global")}
                >
                  <Copy className="h-3 w-3" /> Copy to library
                </Button>
              </>
            ) : null}
            <Button variant="ghost" size="xs" onClick={close} aria-label="Close builder">
              <X className="h-3.5 w-3.5" /> Done
            </Button>
          </div>
        </header>

        {error ? (
          <div className="border-b border-danger/30 bg-danger/10 px-3 py-1.5 text-[11px] text-danger">
            {error}
          </div>
        ) : null}

        {view ? (
          <TemplateEditor
            key={view.id}
            template={view}
            readOnly={draft == null}
            selectedStageId={stageId}
            onSelectStage={setStageId}
            templateInspector
            onChange={
              draft
                ? (next) => {
                    setDraft(next);
                    setDirty(true);
                  }
                : undefined
            }
            footer={
              draft ? (
                <p className="border-t border-edge px-3 py-1 text-[10px] text-ink-faint">
                  Click a palette stage to add it after the last one (drag for free placement) ·
                  drag between handles to add a dependency · select an edge or stage and press
                  Backspace to remove it
                </p>
              ) : null
            }
            className="min-h-0 flex-1"
          />
        ) : (
          <EmptyState icon={LayoutTemplate} title="No templates" />
        )}
      </main>
    </div>
  );
}

const SCOPE_ORDER: TemplateScope[] = ["builtin", "global", "project"];
const SCOPE_LABELS: Record<TemplateScope, string> = {
  builtin: "Built-in",
  global: "Library (all projects)",
  project: "This project",
};

function groupByScope(templates: WorkflowTemplate[]): Record<TemplateScope, WorkflowTemplate[]> {
  const groups: Record<TemplateScope, WorkflowTemplate[]> = {
    builtin: [],
    global: [],
    project: [],
  };
  for (const template of templates) groups[templateScope(template)].push(template);
  return groups;
}

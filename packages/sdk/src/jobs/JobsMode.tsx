import { useCallback, useEffect, useRef, useState } from "react";
import { Activity, ArrowUpRight, Bot, Landmark, ScanSearch, Sparkles, X } from "lucide-react";
import {
  SURVEYS_DIR,
  parseCrystalFile,
  slugify,
  surveyToArchitecture,
  uid,
  type AgentRun,
} from "@crystal/core";
import { autoLayout, buildSurveyPrompt, type SurveyKind } from "@crystal/architect";
import { useAgents, useCrystal, useNavUpdate, useWorkspace } from "@crystal/client";
import { Button, Spinner, StatusDot, Tooltip, cn } from "@crystal/ui";
import { ScopedActionButton, type JobScope } from "./ScopedActionButton.js";

const EMPTY_RUNS: AgentRun[] = [];

/** Changed-file lists per diff scope, plus the total indexed-file count. */
interface Scoped {
  worktree: string[];
  base: string[];
  indexTotal: number;
  indexStale: number;
}

/**
 * The Jobs mode: a home for Crystal's interactive/synchronous *agent* jobs —
 * intent indexing and architecture surveys. Each job dispatches through a
 * scope-aware split button (working-tree diff by default, "vs main" or a full
 * scan on the caret) and its live run is tracked in the shared active-jobs list.
 */
export function JobsMode() {
  const { client } = useCrystal();
  const runs = useAgents((s) => s.runs ?? EMPTY_RUNS);
  const [scoped, setScoped] = useState<Scoped | null>(null);

  const refresh = useCallback(async () => {
    const [wt, base, idx] = await Promise.all([
      client.request("git.changedFiles", { scope: "worktree" }).catch(() => ({ files: [] })),
      client.request("git.changedFiles", { scope: "base" }).catch(() => ({ files: [] })),
      client.request("codeindex.get", {}).catch(() => null),
    ]);
    setScoped({
      worktree: wt.files,
      base: base.files,
      indexTotal: idx?.index.files.length ?? 0,
      indexStale: idx?.staleFiles.length ?? 0,
    });
  }, [client]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Re-pull freshness/diff counts whenever a job run settles — a completed
  // index run changes staleFiles; commits change the diff.
  const settledSig = runs
    .filter((r) => r.purpose === "index" || r.purpose === "survey")
    .map((r) => `${r.id}:${r.status}`)
    .join(",");
  useEffect(() => {
    void refresh();
  }, [settledSig, refresh]);

  return (
    <div className="flex h-full flex-col overflow-y-auto bg-surface-0">
      <header className="flex items-center gap-2 border-b border-edge px-5 py-3">
        <Activity className="h-4 w-4 text-crystal-300" />
        <h1 className="text-sm font-semibold text-ink">Jobs</h1>
        <span className="text-[11px] text-ink-faint">
          Dispatch and watch agent jobs — scoped to your diff by default
        </span>
      </header>

      <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-5">
        <IndexSection scoped={scoped} runs={runs} refresh={refresh} />
        <SurveySection scoped={scoped} runs={runs} />
        <ActiveJobs runs={runs} />
      </div>
    </div>
  );
}

/** Wrapper card for one job section. */
function Section({
  icon,
  title,
  subtitle,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-edge bg-surface-1 p-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="flex items-start gap-2.5">
          <span className="mt-0.5 text-ink-faint">{icon}</span>
          <div>
            <h2 className="text-[13px] font-semibold text-ink">{title}</h2>
            <p className="text-[11px] text-ink-faint">{subtitle}</p>
          </div>
        </div>
      </div>
      {children}
    </section>
  );
}

function IndexSection({
  scoped,
  runs,
  refresh,
}: {
  scoped: Scoped | null;
  runs: AgentRun[];
  refresh: () => Promise<void>;
}) {
  const { client } = useCrystal();
  const [scope, setScope] = useState<JobScope>("worktree");
  const [notice, setNotice] = useState<string | null>(null);

  const busy = runs.some(
    (r) => r.purpose === "index" && (r.status === "running" || r.status === "queued"),
  );

  async function run(next: JobScope): Promise<void> {
    setScope(next);
    const files = next === "full" ? undefined : (scoped?.[next] ?? []);
    if (files && files.length === 0) {
      setNotice("No changed files for this scope — pick Full scan to reindex everything.");
      return;
    }
    setNotice(null);
    try {
      await client.request("codeindex.enrich", files ? { files } : {});
      await refresh();
    } catch (err) {
      setNotice((err as Error).message);
    }
  }

  const freshness = !scoped
    ? "…"
    : scoped.indexStale === 0
      ? `Every one of ${scoped.indexTotal} files carries a fresh intent tag`
      : `${scoped.indexStale} of ${scoped.indexTotal} files need agent indexing`;

  return (
    <Section
      icon={<Sparkles className="h-4 w-4" />}
      title="Intent index"
      subtitle="A cheap agent reads changed files and tags each symbol's intent (auth, payments…)."
    >
      <div className="flex items-center justify-between gap-3">
        <span className="text-[11px] text-ink-muted">{freshness}</span>
        <ScopedActionButton
          label="Index intents"
          icon={<Sparkles className="h-3.5 w-3.5" />}
          scope={scope}
          counts={{
            worktree: scoped?.worktree.length,
            base: scoped?.base.length,
            full: scoped?.indexTotal,
          }}
          busy={busy}
          onRun={run}
        />
      </div>
      {notice ? <p className="mt-2 text-[11px] text-warn">{notice}</p> : null}
    </Section>
  );
}

function SurveySection({ scoped, runs }: { scoped: Scoped | null; runs: AgentRun[] }) {
  const { client } = useCrystal();
  const startRun = useAgents((s) => s.start);
  const createArchitecture = useWorkspace((s) => s.createArchitecture);
  const updateArchitecture = useWorkspace((s) => s.updateArchitecture);
  const updateNav = useNavUpdate();

  const [kind, setKind] = useState<SurveyKind>("codebase");
  const [scope, setScope] = useState<JobScope>("worktree");
  const [notice, setNotice] = useState<string | null>(null);
  const [imported, setImported] = useState<{ name: string; path: string } | null>(null);
  const [pending, setPending] = useState<
    { runId: string; name: string; outFile: string; state: "running" | "importing" | "error"; message?: string }[]
  >([]);
  const importing = useRef(new Set<string>());

  const busy = runs.some(
    (r) => r.purpose === "survey" && (r.status === "running" || r.status === "queued"),
  );

  const importSurvey = useCallback(
    async (path: string, archName: string): Promise<{ name: string; path: string }> => {
      const { content } = await client.request("fs.read", { path });
      const survey = parseCrystalFile("survey", content);
      const { graph } = surveyToArchitecture(survey, archName);
      const laidOut = autoLayout(graph, { mode: "layers" });
      const created = await createArchitecture(laidOut.name);
      updateArchitecture(created.path, { ...laidOut, id: created.graph.id });
      return { name: laidOut.name, path: created.path };
    },
    [client, createArchitecture, updateArchitecture],
  );

  // Import each dispatched survey the moment its agent run completes.
  useEffect(() => {
    for (const p of pending) {
      if (p.state !== "running") continue;
      const runData = runs.find((r) => r.id === p.runId);
      if (!runData) continue;
      if (runData.status === "completed") {
        if (importing.current.has(p.runId)) continue;
        importing.current.add(p.runId);
        setPending((list) => list.map((x) => (x.runId === p.runId ? { ...x, state: "importing" } : x)));
        void importSurvey(p.outFile, p.name)
          .then((created) => {
            setPending((list) => list.filter((x) => x.runId !== p.runId));
            setImported(created);
          })
          .catch((err: Error) => {
            setPending((list) =>
              list.map((x) =>
                x.runId === p.runId ? { ...x, state: "error", message: `import failed: ${err.message}` } : x,
              ),
            );
          });
      } else if (runData.status === "failed" || runData.status === "cancelled") {
        setPending((list) =>
          list.map((x) =>
            x.runId === p.runId ? { ...x, state: "error", message: `agent run ${runData.status}` } : x,
          ),
        );
      }
    }
  }, [runs, pending, importSurvey]);

  async function run(next: JobScope): Promise<void> {
    setScope(next);
    setNotice(null);
    setImported(null);
    const files = next === "full" ? undefined : (scoped?.[next] ?? []);
    if (files && files.length === 0) {
      setNotice("No changed files for this scope — pick Full scan to survey the whole repo.");
      return;
    }
    const archName = kind === "iac" ? "Infra survey" : "Codebase survey";
    const outFile = `${SURVEYS_DIR}/${slugify(archName)}-${uid()}.json`;
    try {
      const runData = await startRun({
        prompt: buildSurveyPrompt({ kind, root: ".", outFile, files }),
        isolation: "none", // The survey file must land in the real workspace.
        purpose: "survey",
        tags: ["purpose:survey"],
      });
      setPending((list) => [{ runId: runData.id, name: archName, outFile, state: "running" }, ...list]);
    } catch (err) {
      setNotice(`Survey agent failed to start: ${(err as Error).message}`);
    }
  }

  return (
    <Section
      icon={<Bot className="h-4 w-4" />}
      title="Architecture survey"
      subtitle="An agent maps the codebase (or its IaC) into a new diagram, imported when it finishes."
    >
      <div className="mb-3 grid grid-cols-2 gap-2" role="radiogroup" aria-label="Survey kind">
        <SurveyChoice
          active={kind === "codebase"}
          onSelect={() => setKind("codebase")}
          icon={<ScanSearch className="h-3.5 w-3.5" />}
          title="Crawl the codebase"
        />
        <SurveyChoice
          active={kind === "iac"}
          onSelect={() => setKind("iac")}
          icon={<Landmark className="h-3.5 w-3.5" />}
          title="Read the IaC"
        />
      </div>
      <div className="flex justify-end">
        <ScopedActionButton
          label="Survey"
          icon={<Bot className="h-3.5 w-3.5" />}
          scope={scope}
          counts={{ worktree: scoped?.worktree.length, base: scoped?.base.length }}
          busy={busy}
          onRun={run}
        />
      </div>

      {pending.map((p) => (
        <div key={p.runId} className="mt-2 flex items-center gap-2 text-[12px] text-ink-muted">
          {p.state === "error" ? (
            <StatusDot status="failed" />
          ) : (
            <Spinner className="h-3.5 w-3.5" />
          )}
          <span className="min-w-0 flex-1 truncate">{p.name}</span>
          <span className={cn("text-[10px]", p.state === "error" ? "text-danger" : "text-ink-faint")}>
            {p.state === "running" ? "agent surveying…" : p.state === "importing" ? "importing…" : p.message}
          </span>
        </div>
      ))}

      {imported ? (
        <button
          type="button"
          onClick={() =>
            updateNav({
              mode: "architect",
              architect: { view: "diagrams", diagram: imported.path },
            })
          }
          className="mt-2 flex items-center gap-1 text-[11px] text-crystal-300 hover:text-crystal-200"
        >
          Imported “{imported.name}” — open in Architecture <ArrowUpRight className="h-3 w-3" />
        </button>
      ) : null}
      {notice ? <p className="mt-2 text-[11px] text-warn">{notice}</p> : null}
    </Section>
  );
}

function SurveyChoice({
  active,
  onSelect,
  icon,
  title,
}: {
  active: boolean;
  onSelect: () => void;
  icon: React.ReactNode;
  title: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onSelect}
      className={cn(
        "flex items-center gap-1.5 rounded-lg border px-2.5 py-2 text-left text-xs font-semibold transition-colors",
        active
          ? "border-crystal-500/60 bg-crystal-500/10 text-ink"
          : "border-edge bg-surface-1 text-ink-muted hover:bg-surface-2",
      )}
    >
      {icon} {title}
    </button>
  );
}

function ActiveJobs({ runs }: { runs: AgentRun[] }) {
  const cancel = useAgents((s) => s.cancel);
  const updateNav = useNavUpdate();
  const jobs = runs.filter((r) => r.purpose === "index" || r.purpose === "survey");

  if (jobs.length === 0) {
    return (
      <p className="px-1 text-[11px] text-ink-faint">
        No jobs yet — dispatch an index or survey above.
      </p>
    );
  }

  return (
    <section>
      <h2 className="mb-1.5 px-1 text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
        Recent jobs
      </h2>
      <div className="flex flex-col gap-0.5">
        {jobs.map((r) => (
          <div
            key={r.id}
            className="group flex items-center gap-2 rounded-lg px-2 py-1.5 text-[12px] hover:bg-surface-2"
          >
            <StatusDot status={r.status} />
            <span className="font-medium text-ink capitalize">{r.purpose}</span>
            {r.model ? <span className="text-[10px] text-ink-faint">{r.model}</span> : null}
            <span className="text-[10px] text-ink-faint">{elapsed(r)}</span>
            <span className="ml-auto flex items-center gap-1.5">
              {r.status === "running" || r.status === "queued" ? (
                <Tooltip content="Cancel run">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Cancel run"
                    onClick={() => void cancel(r.id)}
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </Tooltip>
              ) : null}
              <Tooltip content="Open run detail">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Open run detail"
                  onClick={() => updateNav({ mode: "orchestrate", orchestrate: { tab: "runs", run: r.id } })}
                >
                  <ArrowUpRight className="h-3.5 w-3.5" />
                </Button>
              </Tooltip>
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

/** Human-readable run duration (settled runs show total, live runs show elapsed). */
function elapsed(r: AgentRun): string {
  const start = r.startedAt ?? r.createdAt;
  const end = r.endedAt ?? new Date().toISOString();
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

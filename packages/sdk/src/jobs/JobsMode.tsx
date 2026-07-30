import { useCallback, useEffect, useRef, useState } from "react";
import { Activity, ArrowUpRight, Bot, Landmark, ScanSearch, Sparkles } from "lucide-react";
import {
  SURVEYS_DIR,
  diagramFacetId,
  mergeDiagramIntoOverlay,
  parseCrystalFile,
  slugify,
  surveyToArchitecture,
  uid,
  type AgentRun,
} from "@crystal/core";
import { autoLayout, buildSurveyPrompt, type SurveyKind } from "@crystal/architect";
import { useAgents, useCrystal, useNavUpdate } from "@crystal/client";
import { RunList } from "@crystal/orchestrator";
import { Spinner, StatusDot, cn } from "@crystal/ui";
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
 * scan on the caret) and its runs land in the shared run list below.
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
        <JobRuns runs={runs} />
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
  // A full scan chains runs until the backlog drains; if the newest index run
  // ended failed/cancelled while files are still stale, the chain broke off —
  // say so, or the user is left staring at a silently frozen stale count.
  const lastRun = runs.find((r) => r.purpose === "index");
  const interrupted =
    !busy &&
    (scoped?.indexStale ?? 0) > 0 &&
    (lastRun?.status === "failed" || lastRun?.status === "cancelled")
      ? lastRun
      : null;

  async function run(next: JobScope): Promise<void> {
    setScope(next);
    // "stale" drains the un-indexed backlog server-side (`full: true` chains
    // batches until no file is missing a fresh enrichment).
    const files = next === "worktree" || next === "base" ? (scoped?.[next] ?? []) : undefined;
    if (files && files.length === 0) {
      setNotice(
        "No changed files for this scope — pick Needs indexing to index just the files without fresh tags.",
      );
      return;
    }
    setNotice(null);
    try {
      const { files: batch, remaining } = await client.request(
        "codeindex.enrich",
        files ? { files } : { full: true },
      );
      if (remaining > 0) {
        setNotice(
          files
            ? `Indexing ${batch.length} files now — ${remaining} more still stale after this run.`
            : `Indexing ${batch.length} files now — ${remaining} more will follow in chained runs.`,
        );
      }
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
          scopes={["worktree", "base", "stale"]}
          counts={{
            worktree: scoped?.worktree.length,
            base: scoped?.base.length,
            stale: scoped?.indexStale,
          }}
          busy={busy}
          onRun={run}
        />
      </div>
      {notice ? <p className="mt-2 text-[11px] text-warn">{notice}</p> : null}
      {!notice && interrupted ? (
        <p className="mt-2 text-[11px] text-warn">
          The last index run {interrupted.status === "cancelled" ? "was cancelled" : "failed"} —
          indexing picks up where it left off when you run it again.
        </p>
      ) : null}
    </Section>
  );
}

function SurveySection({ scoped, runs }: { scoped: Scoped | null; runs: AgentRun[] }) {
  const { client, workspaceStore } = useCrystal();
  const startRun = useAgents((s) => s.start);
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
      // Merge into the canonical overlay — the same path as the architect
      // mode's survey import: matched components become customizations of
      // derived systems, the rest lands as manual nodes, and the survey file
      // itself becomes a facet (`diagramFacetId(path)`).
      await workspaceStore.getState().loadArchOverlay();
      const { archOverlay, updateArchOverlay } = workspaceStore.getState();
      if (!archOverlay) throw new Error("architecture overlay unavailable");
      const overview = await client
        .request("codemap.overview", {})
        // No analyzable code (e.g. a pure-IaC repo) — everything the survey
        // found is manual; merge against an empty derivation.
        .catch(() => ({ systems: [], links: [], fileTotal: 0, generatedAt: "" }));
      updateArchOverlay(mergeDiagramIntoOverlay(archOverlay, { path, graph: laidOut }, overview));
      return { name: laidOut.name, path };
    },
    [client, workspaceStore],
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
    const files = next === "worktree" || next === "base" ? (scoped?.[next] ?? []) : undefined;
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
      subtitle="An agent maps the codebase (or its IaC) into a survey, merged into the architecture when it finishes."
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
              architect: { view: "architecture", facet: diagramFacetId(imported.path) },
            })
          }
          className="mt-2 flex items-center gap-1 text-[11px] text-crystal-300 hover:text-crystal-200"
        >
          Merged “{imported.name}” into the architecture — open <ArrowUpRight className="h-3 w-3" />
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

/**
 * The shared run-list treatment over this mode's jobs. Selecting a run
 * deep-links to its full detail in Orchestrate — transcript, cancel and the
 * worktree diff all live on that one surface.
 */
function JobRuns({ runs }: { runs: AgentRun[] }) {
  const updateNav = useNavUpdate();
  const jobs = runs.filter((r) => r.purpose === "index" || r.purpose === "survey");

  return (
    <RunList
      runs={jobs}
      selectedRunId={null}
      onSelect={(id) =>
        updateNav({ mode: "orchestrate", orchestrate: { tab: "runs", run: id } })
      }
      title="Recent jobs"
      emptyHint="No jobs yet — dispatch an index or survey above."
      className="w-full rounded-xl border border-edge"
    />
  );
}

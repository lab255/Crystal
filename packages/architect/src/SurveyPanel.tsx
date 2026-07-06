import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Bot, FileJson, Import, Landmark, ScanSearch, X } from "lucide-react";
import {
  SURVEYS_DIR,
  parseCrystalFile,
  slugify,
  surveyToArchitecture,
  uid,
  type FileEntry,
} from "@crystal/core";
import { useAgents, useCrystal, useWorkspace } from "@crystal/client";
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  Input,
  Spinner,
  Tooltip,
  cn,
} from "@crystal/ui";
import { autoLayout } from "./layout.js";
import { buildSurveyPrompt, type SurveyKind } from "./survey-prompts.js";

const EMPTY_RUNS: never[] = [];

interface PendingSurvey {
  runId: string;
  name: string;
  outFile: string;
  state: "running" | "importing" | "error";
  message?: string;
}

/**
 * "Survey with an agent" — dispatch an agent to crawl the codebase (or read
 * its IaC) and emit a survey file, then import the result as a new
 * architecture. Also lists survey files already sitting in `.crystal/surveys/`
 * (from earlier runs, other tools, or teammates) for manual import.
 */
export function SurveySection({
  onImported,
  onNotice,
}: {
  /** A survey was imported as a new architecture at this path — select it. */
  onImported: (archPath: string) => void;
  onNotice: (message: string) => void;
}) {
  const { client } = useCrystal();
  const runs = useAgents((s) => s.runs ?? EMPTY_RUNS);
  const startRun = useAgents((s) => s.start);
  const createArchitecture = useWorkspace((s) => s.createArchitecture);
  const updateArchitecture = useWorkspace((s) => s.updateArchitecture);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [kind, setKind] = useState<SurveyKind>("codebase");
  const [name, setName] = useState("");
  const [root, setRoot] = useState(".");
  const [starting, setStarting] = useState(false);
  const [pending, setPending] = useState<PendingSurvey[]>([]);
  const [available, setAvailable] = useState<FileEntry[]>([]);
  const importing = useRef(new Set<string>());

  const refreshAvailable = useCallback(async () => {
    try {
      const { entries } = await client.request("fs.list", { path: SURVEYS_DIR });
      setAvailable(entries.filter((e) => e.kind === "file" && e.name.endsWith(".json")));
    } catch {
      setAvailable([]); // Directory doesn't exist until the first survey lands.
    }
  }, [client]);

  useEffect(() => {
    void refreshAvailable();
  }, [refreshAvailable]);

  const importSurvey = useCallback(
    async (path: string, archName?: string) => {
      const { content } = await client.request("fs.read", { path });
      const survey = parseCrystalFile("survey", content);
      const { graph, warnings } = surveyToArchitecture(survey, archName);
      const laidOut = autoLayout(graph, { mode: "layers" });
      const created = await createArchitecture(laidOut.name);
      updateArchitecture(created.path, { ...laidOut, id: created.graph.id });
      onImported(created.path);
      onNotice(
        warnings.length
          ? `Survey imported as “${laidOut.name}” — ${warnings.join(" · ")}`
          : `Survey imported as “${laidOut.name}”.`,
      );
      return created.path;
    },
    [client, createArchitecture, updateArchitecture, onImported, onNotice],
  );

  // Import each dispatched survey the moment its agent run completes.
  useEffect(() => {
    for (const p of pending) {
      if (p.state !== "running") continue;
      const run = runs.find((r) => r.id === p.runId);
      if (!run) continue;
      if (run.status === "completed") {
        if (importing.current.has(p.runId)) continue;
        importing.current.add(p.runId);
        setPending((list) =>
          list.map((x) => (x.runId === p.runId ? { ...x, state: "importing" } : x)),
        );
        void importSurvey(p.outFile, p.name)
          .then(() => {
            setPending((list) => list.filter((x) => x.runId !== p.runId));
            void refreshAvailable();
          })
          .catch((err: Error) => {
            setPending((list) =>
              list.map((x) =>
                x.runId === p.runId
                  ? { ...x, state: "error", message: `import failed: ${err.message}` }
                  : x,
              ),
            );
            void refreshAvailable();
          });
      } else if (run.status === "failed" || run.status === "cancelled") {
        setPending((list) =>
          list.map((x) =>
            x.runId === p.runId
              ? { ...x, state: "error", message: `agent run ${run.status}` }
              : x,
          ),
        );
      }
    }
  }, [runs, pending, importSurvey, refreshAvailable]);

  async function dispatch() {
    const archName =
      name.trim() || (kind === "iac" ? "Infra survey" : "Codebase survey");
    const scope = root.trim() || ".";
    const outFile = `${SURVEYS_DIR}/${slugify(archName)}-${uid()}.json`;
    setStarting(true);
    try {
      const run = await startRun({
        prompt: buildSurveyPrompt({ kind, root: scope, outFile }),
        isolation: "none", // The survey file must land in the real workspace.
      });
      setPending((list) => [
        { runId: run.id, name: archName, outFile, state: "running" },
        ...list,
      ]);
      setDialogOpen(false);
      setName("");
      setRoot(".");
    } catch (err) {
      onNotice(`Survey agent failed to start: ${(err as Error).message}`);
    } finally {
      setStarting(false);
    }
  }

  // Files already imported this session keep showing until refresh; filter
  // out the ones an in-flight run is about to import.
  const pendingFiles = new Set(pending.map((p) => p.outFile));
  const importable = available.filter((f) => !pendingFiles.has(f.path));

  return (
    <div className="mt-3">
      <div className="flex items-center justify-between px-1.5 pb-1">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
          Surveys
        </span>
        <Tooltip content="Dispatch an agent to map this workspace">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setDialogOpen(true)}
            aria-label="Survey with an agent"
          >
            <Bot className="h-3.5 w-3.5" />
          </Button>
        </Tooltip>
      </div>

      {pending.map((p) => (
        <div
          key={p.runId}
          className="group flex items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] text-ink-muted"
        >
          {p.state === "error" ? (
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-danger" />
          ) : (
            <Spinner className="h-3.5 w-3.5 shrink-0" />
          )}
          <span className="min-w-0 flex-1 truncate">{p.name}</span>
          <span
            className={cn(
              "truncate text-[10px]",
              p.state === "error" ? "text-danger" : "text-ink-faint",
            )}
          >
            {p.state === "running"
              ? "agent surveying…"
              : p.state === "importing"
                ? "importing…"
                : p.message}
          </span>
          {p.state === "error" ? (
            <button
              type="button"
              className="shrink-0 text-ink-faint hover:text-ink"
              onClick={() => setPending((list) => list.filter((x) => x.runId !== p.runId))}
              aria-label="Dismiss"
            >
              <X className="h-3 w-3" />
            </button>
          ) : null}
        </div>
      ))}

      {importable.map((f) => (
        <div
          key={f.path}
          className="group flex items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] text-ink-muted hover:bg-surface-2 hover:text-ink"
        >
          <FileJson className="h-3.5 w-3.5 shrink-0 opacity-70" />
          <span className="min-w-0 flex-1 truncate" title={f.path}>
            {f.name}
          </span>
          <Tooltip content="Import as a new architecture">
            <Button
              variant="ghost"
              size="icon-sm"
              className="opacity-0 group-hover:opacity-100"
              aria-label={`Import ${f.name}`}
              onClick={() =>
                void importSurvey(f.path).catch((err: Error) =>
                  onNotice(`Import failed: ${err.message}`),
                )
              }
            >
              <Import className="h-3.5 w-3.5" />
            </Button>
          </Tooltip>
        </div>
      ))}

      {pending.length === 0 && importable.length === 0 ? (
        <div className="px-2 py-1 text-[11px] text-ink-faint">
          Send an agent to map an unfamiliar codebase — or its IaC — into a diagram.
        </div>
      ) : null}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent
          title="Survey with an agent"
          description={`The agent crawls read-only and writes its findings to ${SURVEYS_DIR}/ as a versioned survey file, imported here when the run completes.`}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void dispatch();
            }}
            className="space-y-3"
          >
            <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Survey kind">
              <SurveyChoice
                active={kind === "codebase"}
                onSelect={() => setKind("codebase")}
                icon={<ScanSearch className="h-3.5 w-3.5" />}
                title="Crawl the codebase"
              >
                Map runtime components and journeys, and suggest a deployment pattern
              </SurveyChoice>
              <SurveyChoice
                active={kind === "iac"}
                onSelect={() => setKind("iac")}
                icon={<Landmark className="h-3.5 w-3.5" />}
                title="Read the IaC"
              >
                Reconstruct the deployment pattern the infra-as-code encodes
              </SurveyChoice>
            </div>
            <Input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={kind === "iac" ? "e.g. Production infra" : "e.g. Payments platform"}
              aria-label="Architecture name"
            />
            <label className="flex items-center gap-2 text-[11px] text-ink-faint">
              Scope
              <Input
                value={root}
                onChange={(e) => setRoot(e.target.value)}
                className="flex-1"
                placeholder="."
                aria-label="Workspace-relative root to survey"
              />
            </label>
            <div className="flex justify-end gap-2">
              <DialogClose asChild>
                <Button variant="ghost" size="sm">
                  Cancel
                </Button>
              </DialogClose>
              <Button type="submit" variant="primary" size="sm" disabled={starting}>
                {starting ? <Spinner className="h-3.5 w-3.5" /> : <Bot className="h-3.5 w-3.5" />}
                Dispatch agent
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function SurveyChoice({
  active,
  onSelect,
  icon,
  title,
  children,
}: {
  active: boolean;
  onSelect: () => void;
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onSelect}
      className={cn(
        "rounded-lg border px-2.5 py-2 text-left transition-colors",
        active
          ? "border-crystal-500/60 bg-crystal-500/10"
          : "border-edge bg-surface-1 hover:bg-surface-2",
      )}
    >
      <span
        className={cn(
          "flex items-center gap-1.5 text-xs font-semibold",
          active ? "text-ink" : "text-ink-muted",
        )}
      >
        {icon} {title}
      </span>
      <span className="mt-1 block text-[10.5px] leading-snug text-ink-faint">{children}</span>
    </button>
  );
}

import { useCallback, useEffect, useState } from "react";
import { Bot, FileJson, Import } from "lucide-react";
import {
  SURVEYS_DIR,
  parseCrystalFile,
  surveyToArchitecture,
  type FileEntry,
} from "@crystal/core";
import { useCrystal, useNavUpdate, useWorkspace } from "@crystal/client";
import { Button, Tooltip } from "@crystal/ui";
import { autoLayout } from "./layout.js";

/**
 * Survey files on disk: dispatching a new survey now lives in the Jobs mode
 * (scoped to your diff by default); this panel lists the survey files already
 * sitting in `.crystal/surveys/` — from earlier runs, other tools, or
 * teammates — so any of them can be imported as a new architecture.
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
  const updateNav = useNavUpdate();
  const createArchitecture = useWorkspace((s) => s.createArchitecture);
  const updateArchitecture = useWorkspace((s) => s.updateArchitecture);

  const [available, setAvailable] = useState<FileEntry[]>([]);

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
    async (path: string) => {
      const { content } = await client.request("fs.read", { path });
      const survey = parseCrystalFile("survey", content);
      const { graph, warnings } = surveyToArchitecture(survey);
      const laidOut = autoLayout(graph, { mode: "layers" });
      const created = await createArchitecture(laidOut.name);
      updateArchitecture(created.path, { ...laidOut, id: created.graph.id });
      onImported(created.path);
      onNotice(
        warnings.length
          ? `Survey imported as “${laidOut.name}” — ${warnings.join(" · ")}`
          : `Survey imported as “${laidOut.name}”.`,
      );
    },
    [client, createArchitecture, updateArchitecture, onImported, onNotice],
  );

  return (
    <div className="mt-3">
      <div className="flex items-center justify-between px-1.5 pb-1">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
          Surveys
        </span>
        <Tooltip content="Dispatch a survey agent in the Jobs view">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => updateNav({ mode: "jobs" })}
            aria-label="Survey with an agent (opens Jobs)"
          >
            <Bot className="h-3.5 w-3.5" />
          </Button>
        </Tooltip>
      </div>

      {available.map((f) => (
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

      {available.length === 0 ? (
        <div className="px-2 py-1 text-[11px] text-ink-faint">
          Send an agent to map an unfamiliar codebase — or its IaC — into a diagram, from the Jobs
          view.
        </div>
      ) : null}
    </div>
  );
}

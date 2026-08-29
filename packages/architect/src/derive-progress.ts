import type { CodeMapProgress } from "@crystal/core";

/**
 * The architecture derivation as the user sees it: five stages spanning two
 * processes. Stages 1-3 are the analyzer's own `codemap.progress` phases
 * (worker thread on the server); stage 4 is the server building the code
 * index + system overview after the analyzer reports `done` (no progress
 * events — only the pending request tells us); stage 5 is the client
 * composing + laying out once the data lands.
 */
export type DeriveStageId = "discover" | "parse" | "resolve" | "derive" | "layout";
export type DeriveStageStatus = "pending" | "active" | "done";

export interface DeriveStage {
  id: DeriveStageId;
  label: string;
  status: DeriveStageStatus;
  /** 0..1 within the stage when the server reports counts, else null. */
  fraction: number | null;
}

export const DERIVE_STAGES: readonly { id: DeriveStageId; label: string }[] = [
  { id: "discover", label: "Discover files" },
  { id: "parse", label: "Parse sources" },
  { id: "resolve", label: "Resolve imports" },
  { id: "derive", label: "Index & derive systems" },
  { id: "layout", label: "Compose & lay out" },
];

export interface DeriveState {
  progress: CodeMapProgress | null;
  /** Inputs request still pending on the client. */
  loading: boolean;
  /** Overview + summary landed for the active workspace. */
  hasData: boolean;
  /** Composed graph is ready to render. */
  rendered: boolean;
}

const PHASE_STAGE: Record<CodeMapProgress["phase"], DeriveStageId> = {
  discovering: "discover",
  parsing: "parse",
  resolving: "resolve",
  done: "derive",
};

/** Which stage is active right now, from the union of server + client signals. */
export function activeDeriveStage(s: DeriveState): DeriveStageId {
  if (s.hasData) return "layout";
  if (!s.progress) return s.loading ? "discover" : "layout";
  return PHASE_STAGE[s.progress.phase];
}

export function deriveStages(s: DeriveState): DeriveStage[] {
  const active = activeDeriveStage(s);
  const activeIdx = DERIVE_STAGES.findIndex((d) => d.id === active);
  const p = s.progress;
  return DERIVE_STAGES.map((d, i) => {
    const status: DeriveStageStatus =
      s.rendered || i < activeIdx ? "done" : i === activeIdx ? "active" : "pending";
    let fraction: number | null = null;
    if (status === "done") fraction = 1;
    else if (status === "active" && d.id === "parse" && p?.total) {
      fraction = Math.min(1, Math.max(0, (p.done ?? 0) / p.total));
    }
    return { id: d.id, label: d.label, status, fraction };
  });
}

/** Overall 0..1 for a single summary bar: equal-weight stages, parse fills by file count. */
export function deriveOverallFraction(stages: readonly DeriveStage[]): number {
  const per = 1 / stages.length;
  return stages.reduce((sum, st) => sum + per * (st.fraction ?? 0), 0);
}

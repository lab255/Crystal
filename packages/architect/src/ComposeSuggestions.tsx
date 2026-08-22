import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from "react";
import { AlertTriangle, ChevronDown, ChevronRight, Container, X } from "lucide-react";
import { useActiveWorkspace, useCrystal } from "@crystal/client";
import { isComposePath, type ArchEnvironment, type ArchitectureGraph, type ComposeServiceSuggestion, type ComposeSuggestionResult } from "@crystal/core";
import { applyComposeSuggestions, isComposeSuggestionAdopted } from "./compose-adopt.js";

export function ComposeSuggestions(props: {
  graph: ArchitectureGraph;
  environment: ArchEnvironment | null;
  onAdopt: (next: ArchitectureGraph) => void;
}): JSX.Element | null {
  const { client } = useCrystal();
  const workspace = useActiveWorkspace();
  const [result, setResult] = useState<ComposeSuggestionResult | null>(null);
  const [collapsed, setCollapsed] = useState(true);
  const [dismissed, setDismissed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fetchSuggestions = useCallback(() => {
    setDismissed(false);
    void client.request("infra.composeSuggest", {}).then(setResult).catch(() => setResult(null));
  }, [client]);

  useEffect(() => {
    fetchSuggestions();
    return client.events.on("fs.changed", ({ ws, paths }) => {
      if (ws !== workspace?.id || !paths.some(isComposePath)) return;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(fetchSuggestions, 200);
    });
  }, [client, fetchSuggestions, workspace?.id]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const suggestions = result?.suggestions ?? [];
  const diagnostics = result?.diagnostics ?? [];
  const envId = props.environment?.id;
  const pending = useMemo(() => envId ? suggestions.filter((suggestion) => !isComposeSuggestionAdopted(props.graph, envId, suggestion)) : suggestions, [envId, props.graph, suggestions]);
  if (!result || (suggestions.length === 0 && diagnostics.length === 0) || dismissed) return null;
  const unreadableCount = new Set(diagnostics.map((diagnostic) => diagnostic.path)).size;
  const adopt = (selected: readonly ComposeServiceSuggestion[]) => {
    if (!envId) return;
    const next = applyComposeSuggestions(props.graph, envId, selected);
    if (next !== props.graph) props.onAdopt(next);
  };

  return <div className="w-80 overflow-hidden rounded-lg border border-edge bg-surface-1 shadow-lg">
    <div className="flex items-center">
      <button type="button" className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left text-xs font-medium text-ink" onClick={() => setCollapsed((value) => !value)}>
        {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}{diagnostics.length > 0 ? <AlertTriangle size={14} className="text-warn" /> : <Container size={14} />}
        <span className="flex-1">{suggestions.length === 0 ? `${unreadableCount} compose file${unreadableCount === 1 ? "" : "s"} could not be read` : "Compose topology"}</span>{suggestions.length > 0 && <span className="text-ink-muted">{suggestions.length}</span>}
      </button>
      <button type="button" aria-label="Dismiss compose suggestions" className="mr-2 rounded p-1 text-ink-muted hover:bg-surface-active hover:text-ink" onClick={() => setDismissed(true)}><X size={13} /></button>
    </div>
    {!collapsed && <div className="border-t border-edge px-3 py-2">
      {suggestions.length > 0 && <div className="mb-2 flex items-center justify-between text-[11px] text-ink-muted"><span>{result.files.length} file{result.files.length === 1 ? "" : "s"}</span><button type="button" disabled={!envId || pending.length === 0} className="rounded border border-accent-blue/25 bg-accent-blue/12 px-2 py-1 text-accent-blue disabled:opacity-40" onClick={() => adopt(pending)}>Adopt all</button></div>}
      {diagnostics.length > 0 && <div className="mb-2 space-y-1">{diagnostics.map((diagnostic, index) => <div key={`${diagnostic.path}:${index}`} className={diagnostic.severity === "error" ? "text-[10px] text-danger" : "text-[10px] text-warn"}><span className="font-medium">{diagnostic.path}</span>: {diagnostic.message}</div>)}</div>}
      <div className="max-h-64 space-y-1 overflow-auto">{suggestions.map((suggestion) => {
        const adopted = !!envId && isComposeSuggestionAdopted(props.graph, envId, suggestion);
        return <div key={suggestion.key} className="flex items-center gap-2 rounded bg-surface px-2 py-1.5 text-xs"><div className="min-w-0 flex-1"><div className="truncate font-medium text-ink">{suggestion.service}</div><div className="truncate text-[10px] text-ink-muted">{suggestion.external?.name ?? suggestion.tech}</div></div><button type="button" disabled={!envId || adopted} className="rounded border border-edge px-2 py-1 text-[10px] text-ink disabled:opacity-50" onClick={() => adopt([suggestion])}>{adopted ? "Adopted" : "Adopt"}</button></div>;
      })}</div>
    </div>}
  </div>;
}

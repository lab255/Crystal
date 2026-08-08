import { useCallback, useState } from "react";
import {
  BookmarkPlus,
  GitCompareArrows,
  RefreshCw,
  Sparkles,
  Telescope,
  Trash2,
  X,
} from "lucide-react";
import {
  createWorkspaceFacet,
  formatLensParam,
  lensLabel,
  suggestIndexFacets,
  type IndexFacetSuggestion,
  type LensSpec,
} from "@crystal/core";
import { RefCombobox, useCrystal, useLens, useNav, useNavUpdate, useWorkspaces } from "@crystal/client";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
  Spinner,
  Tooltip,
  cn,
} from "@crystal/ui";

/** How many member files ride along in an Ask AI prompt before "+N more". */
const ASK_FILE_LIMIT = 40;

const DIFF_WORKTREE = formatLensParam({ kind: "diff", scope: "worktree" });
const DIFF_BASE = formatLensParam({ kind: "diff", scope: "base" });

export interface LensBarProps {
  /** Reveal the terminal panel so an Ask AI console is visible when its run starts. */
  onOpenTerminal?: () => void;
}

/**
 * Header control for the global lens (the top-level `lens` deep-link param
 * every mode renders through). Idle it's a compact "Lens" menu — review diffs
 * (working tree / vs base / vs any ref) and saved workspace facets; active
 * it's a chip with the resolved member count, refresh, save-as-facet and
 * clear. "Ask AI" pipes the current slice (deep link + lens membership) into
 * a fresh agent console.
 */
export function LensBar({ onOpenTerminal }: LensBarProps) {
  const { client, lensStore, terminalsStore } = useCrystal();
  const activeWsId = useWorkspaces((s) => s.activeId);
  const activeWsRoot = useWorkspaces(
    (s) => s.workspaces.find((w) => w.id === s.activeId)?.root ?? null,
  );
  const lensParam = useNav((l) => l.lens ?? null);
  const updateNav = useNavUpdate();

  const spec = useLens((s) => s.spec);
  const membership = useLens((s) => s.membership);
  const matcherEmpty = useLens((s) => s.matcher.empty);
  const status = useLens((s) => s.status);
  const lensError = useLens((s) => s.error);
  const facets = useLens((s) => s.facets);
  const facetsWs = useLens((s) => s.facetsWs);

  const [menuOpen, setMenuOpen] = useState(false);
  const [suggested, setSuggested] = useState<IndexFacetSuggestion[] | null>(null);
  const [refValue, setRefValue] = useState("");
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [askOpen, setAskOpen] = useState(false);
  const [askText, setAskText] = useState("");
  const [barError, setBarError] = useState<string | null>(null);

  // Saved facets load lazily when the menu opens (cached per workspace);
  // suggested facets ride the same open (from the code index, best-effort).
  const onMenuOpenChange = useCallback(
    (open: boolean) => {
      setMenuOpen(open);
      if (open && activeWsId) {
        void lensStore
          .getState()
          .loadFacets(activeWsId)
          .catch((err: Error) => setBarError(err.message));
        client
          .request("codeindex.get", {})
          .then((res) => setSuggested(suggestIndexFacets(res.index).slice(0, 6)))
          .catch(() => setSuggested([]));
      }
    },
    [activeWsId, lensStore, client],
  );

  const setLens = useCallback(
    (param: string | null) => {
      setBarError(null);
      updateNav({ lens: param });
      setMenuOpen(false);
    },
    [updateNav],
  );

  const deleteFacet = useCallback(
    (id: string) => {
      if (!activeWsId) return;
      lensStore
        .getState()
        .removeFacet(activeWsId, id)
        .catch((err: Error) => setBarError(err.message));
      // Deleting the facet you're looking through clears the lens too.
      if (lensParam === `facet:${id}`) updateNav({ lens: null });
    },
    [activeWsId, lensStore, lensParam, updateNav],
  );

  const saveAsFacet = useCallback(() => {
    const name = saveName.trim();
    if (!name || !activeWsId || !spec || spec.kind === "facet") return;
    const facet = createWorkspaceFacet(name, spec);
    lensStore
      .getState()
      .saveFacet(activeWsId, facet)
      .then(() => updateNav({ lens: `facet:${facet.id}` }))
      .catch((err: Error) => setBarError(err.message));
    setSaveOpen(false);
    setSaveName("");
  }, [saveName, activeWsId, spec, lensStore, updateNav]);

  const submitAsk = useCallback(() => {
    const question = askText.trim();
    if (!question || !activeWsId) return;
    setBarError(null);
    const prompt = buildAskPrompt({
      question,
      href: typeof window !== "undefined" ? window.location.href : "",
      root: activeWsRoot,
      spec,
      label: spec ? lensLabel(spec, facets) : null,
      files: membership?.files ?? [],
      dirs: membership?.dirs ?? [],
    });
    try {
      const terminals = terminalsStore.getState();
      const consoleId = terminals.openAgentConsole(activeWsId);
      onOpenTerminal?.();
      setAskOpen(false);
      setAskText("");
      terminals.send(consoleId, prompt).catch((err: Error) => setBarError(err.message));
    } catch (err) {
      setBarError((err as Error).message);
    }
  }, [askText, activeWsId, activeWsRoot, spec, facets, membership, terminalsStore, onOpenTerminal]);

  if (!activeWsId) return null;

  // The nav param is the source of truth for "a lens is active"; the resolved
  // spec can lag one tick behind while the store catches up.
  const activeSpec = lensParam !== null && spec !== null ? spec : null;
  const wsFacets = facetsWs === activeWsId ? facets : null;
  const canSave = activeSpec !== null && activeSpec.kind !== "facet";
  const fileCount = membership?.files.length ?? 0;
  const dirCount = membership?.dirs.length ?? 0;

  const menu = (
    <DropdownMenuContent align="end" side="bottom" className="min-w-64">
      <DropdownMenuLabel>Review diff</DropdownMenuLabel>
      <DropdownMenuRadioGroup value={lensParam ?? ""} onValueChange={setLens}>
        {[
          { param: DIFF_WORKTREE, label: "Working tree changes" },
          { param: DIFF_BASE, label: "Diff vs base branch" },
        ].map(({ param, label }) => (
          <DropdownMenuRadioItem key={param} value={param} className="gap-2">
            <GitCompareArrows className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
            <span className="min-w-0 flex-1 truncate">{label}</span>
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
      {/* Not a menu item: the combobox needs real keyboard input, so Radix
          typeahead must not see these keystrokes. */}
      <div
        className="flex items-center gap-2 px-2 py-1.5"
        onKeyDown={(e) => e.stopPropagation()}
      >
        <GitCompareArrows className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
        <span className="shrink-0 text-xs text-ink">Diff vs ref…</span>
        <RefCombobox
          value={refValue}
          onChange={setRefValue}
          onSubmit={(ref) => {
            const trimmed = ref.trim();
            if (trimmed) setLens(formatLensParam({ kind: "diff", scope: { ref: trimmed } }));
          }}
          className="min-w-0 flex-1"
          inputClassName="h-6 rounded-md px-2 text-xs"
        />
      </div>

      <DropdownMenuSeparator />
      <DropdownMenuLabel>Saved facets</DropdownMenuLabel>
      {wsFacets === null ? (
        <div className="flex items-center gap-2 px-2 py-1 text-[11px] text-ink-faint">
          <Spinner className="h-3 w-3" /> loading…
        </div>
      ) : wsFacets.length === 0 ? (
        <div className="px-2 py-1 text-[11px] text-ink-faint">
          No saved facets yet — save one from an active lens
        </div>
      ) : (
        <DropdownMenuRadioGroup value={lensParam ?? ""} onValueChange={setLens}>
          {wsFacets.map((f) => {
            const param = `facet:${f.id}`;
            return (
              <DropdownMenuRadioItem key={f.id} value={param} className="group gap-2">
                <Telescope className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
                <span className="min-w-0 flex-1 truncate">{f.name}</span>
                <button
                  type="button"
                  aria-label={`Delete facet ${f.name}`}
                  onClick={(e) => {
                    // Keep the menu open; the row's onSelect must not fire.
                    e.stopPropagation();
                    e.preventDefault();
                    deleteFacet(f.id);
                  }}
                  onPointerDown={(e) => e.stopPropagation()}
                  className="shrink-0 rounded p-0.5 text-ink-faint opacity-0 transition-opacity hover:text-danger group-hover:opacity-100 group-data-[highlighted]:opacity-100"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </DropdownMenuRadioItem>
            );
          })}
        </DropdownMenuRadioGroup>
      )}

      <DropdownMenuSeparator />
      <DropdownMenuLabel>Suggested facets</DropdownMenuLabel>
      {suggested === null ? (
        <div className="flex items-center gap-2 px-2 py-1 text-[11px] text-ink-faint">
          <Spinner className="h-3 w-3" /> loading…
        </div>
      ) : suggested.length === 0 ? (
        <div className="px-2 py-1 text-[11px] text-ink-faint">
          No suggestions yet — run indexing from Jobs
        </div>
      ) : (
        <DropdownMenuRadioGroup value={lensParam ?? ""} onValueChange={setLens}>
          {suggested.map((s) => {
            const param = s.tags.join(",");
            return (
              <DropdownMenuRadioItem key={param} value={param} className="gap-2">
                <Sparkles className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
                <span className="min-w-0 flex-1 truncate">{s.name}</span>
                <span className="shrink-0 text-[10px] text-ink-faint">{s.members} members</span>
              </DropdownMenuRadioItem>
            );
          })}
        </DropdownMenuRadioGroup>
      )}
    </DropdownMenuContent>
  );

  return (
    <div className="flex min-w-0 shrink items-center gap-1">
      <DropdownMenu open={menuOpen} onOpenChange={onMenuOpenChange}>
        {activeSpec ? (
          <span className="flex h-6 min-w-0 items-center gap-0.5 rounded-md border border-crystal-500/40 bg-crystal-500/10 pl-1.5 pr-0.5">
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="Change lens"
                className="flex min-w-0 items-center gap-1.5 text-xs text-crystal-300 transition-colors hover:text-ink"
              >
                <Telescope className="h-3.5 w-3.5 shrink-0" />
                <span className="max-w-44 truncate">{lensLabel(activeSpec, wsFacets ?? facets)}</span>
                {status === "loading" ? (
                  <Spinner className="h-3 w-3 shrink-0" />
                ) : status === "error" ? (
                  <span className="max-w-32 truncate text-[10px] text-danger" title={lensError ?? undefined}>
                    {lensError ?? "error"}
                  </span>
                ) : status === "ready" && matcherEmpty ? (
                  <span className="shrink-0 text-[10px] text-ink-faint">no matches</span>
                ) : status === "ready" ? (
                  <span className="shrink-0 text-[10px] text-ink-faint">
                    {fileCount} file{fileCount === 1 ? "" : "s"}
                    {dirCount > 0 ? ` · ${dirCount} dir${dirCount === 1 ? "" : "s"}` : ""}
                  </span>
                ) : null}
              </button>
            </DropdownMenuTrigger>
            <Tooltip content="Re-resolve the lens">
              <button
                type="button"
                aria-label="Refresh lens"
                onClick={() => void lensStore.getState().refresh()}
                className="rounded p-0.5 text-ink-faint transition-colors hover:bg-surface-3 hover:text-ink"
              >
                <RefreshCw className="h-3 w-3" />
              </button>
            </Tooltip>
            {canSave ? (
              <Tooltip content="Save as facet">
                <button
                  type="button"
                  aria-label="Save lens as facet"
                  aria-pressed={saveOpen}
                  onClick={() => {
                    setSaveOpen((o) => !o);
                    setAskOpen(false);
                  }}
                  className={cn(
                    "rounded p-0.5 transition-colors hover:bg-surface-3 hover:text-ink",
                    saveOpen ? "text-ink" : "text-ink-faint",
                  )}
                >
                  <BookmarkPlus className="h-3 w-3" />
                </button>
              </Tooltip>
            ) : null}
            <Tooltip content="Clear lens">
              <button
                type="button"
                aria-label="Clear lens"
                onClick={() => setLens(null)}
                className="rounded p-0.5 text-ink-faint transition-colors hover:bg-surface-3 hover:text-danger"
              >
                <X className="h-3 w-3" />
              </button>
            </Tooltip>
          </span>
        ) : (
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Lens picker"
              className="flex h-6 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs text-ink-muted transition-colors hover:bg-surface-3 hover:text-ink"
            >
              <Telescope className="h-3.5 w-3.5" />
              <span>Lens</span>
            </button>
          </DropdownMenuTrigger>
        )}
        {menu}
      </DropdownMenu>

      {saveOpen && canSave ? (
        <Input
          autoFocus
          value={saveName}
          onChange={(e) => setSaveName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") saveAsFacet();
            else if (e.key === "Escape") setSaveOpen(false);
          }}
          placeholder="Facet name…"
          aria-label="New facet name"
          className="h-6 w-36 rounded-md px-2 text-xs"
        />
      ) : null}

      <Tooltip content="Ask AI about this slice">
        <button
          type="button"
          aria-label="Ask AI"
          aria-pressed={askOpen}
          onClick={() => {
            setAskOpen((o) => !o);
            setSaveOpen(false);
            setBarError(null);
          }}
          className={cn(
            "flex h-6 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs transition-colors hover:bg-surface-3 hover:text-ink",
            askOpen ? "bg-surface-3 text-ink" : "text-ink-muted",
          )}
        >
          <Sparkles className="h-3.5 w-3.5" />
          <span>Ask AI</span>
        </button>
      </Tooltip>

      {askOpen ? (
        <Input
          autoFocus
          value={askText}
          onChange={(e) => setAskText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submitAsk();
            else if (e.key === "Escape") setAskOpen(false);
          }}
          placeholder="Ask about this slice… e.g. is there an existing pattern for this?"
          aria-label="Ask AI about this slice"
          className="h-6 w-72 rounded-md px-2 text-xs"
        />
      ) : null}

      {barError ? (
        <span className="max-w-56 truncate text-[10px] text-danger" title={barError}>
          {barError}
        </span>
      ) : null}
    </div>
  );
}

/** The Ask AI prompt: question first, then the slice's context for the agent. */
function buildAskPrompt(args: {
  question: string;
  href: string;
  root: string | null;
  spec: LensSpec | null;
  label: string | null;
  files: readonly string[];
  dirs: readonly string[];
}): string {
  const { question, href, root, spec, label, files, dirs } = args;
  const lines: string[] = [question, "", "Context:"];
  if (href) lines.push(`- Deep link: ${href}`);
  if (spec && label) {
    lines.push(`- Active lens: ${label} (spec: ${JSON.stringify(spec)})`);
    if (files.length > 0) {
      const shown = files.slice(0, ASK_FILE_LIMIT);
      const more = files.length - shown.length;
      lines.push(`- Member files (${files.length}):`);
      for (const f of shown) lines.push(`  - ${f}`);
      if (more > 0) lines.push(`  - …+${more} more`);
    }
    if (dirs.length > 0) lines.push(`- Member dirs: ${dirs.join(", ")}`);
  }
  lines.push(
    "",
    `You are looking at the Crystal workspace ${root ?? "(unknown root)"}. Answer with concrete file/symbol references.`,
  );
  return lines.join("\n");
}

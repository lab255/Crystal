import { useEffect, useRef } from "react";
import { FlaskConical, RefreshCw, Search, ShieldCheck, Umbrella, X } from "lucide-react";
import type { QualityViewId } from "@crystal/core";
import { useNav, useNavUpdate } from "@crystal/client";
import { Spinner, Tooltip, cn } from "@crystal/ui";
import { CoverageView } from "./CoverageView.js";
import { QualityProvider, useQuality } from "./common.js";
import { TestsView } from "./TestsView.js";

/**
 * Quality — the workspace's test runner and coverage visualiser in one tool.
 * Tests run with the workspace's own runner (vitest/jest/`test` script) and
 * stream results live; coverage renders whatever istanbul output exists.
 * Every subview and selection is a deep link (`#/quality/<view>?…`).
 */

const VIEW_META: { id: QualityViewId; label: string; icon: typeof FlaskConical }[] = [
  { id: "tests", label: "Tests", icon: FlaskConical },
  { id: "coverage", label: "Coverage", icon: Umbrella },
];

export function QualityMode() {
  return (
    <QualityProvider>
      <QualityShell />
    </QualityProvider>
  );
}

function QualityShell() {
  const nav = useNavUpdate();
  const view = useNav((l) => l.quality?.view) ?? "tests";
  const find = useNav((l) => l.quality?.find) ?? "";
  const { info, runs, coverage, liveRun, loading, refresh } = useQuality();
  const findRef = useRef<HTMLInputElement>(null);

  // Gated on the active mode — hidden-but-mounted modes must not swallow
  // Ctrl+F (same pattern as ArchitectMode).
  const activeMode = useNav((l) => l.mode) ?? "quality";
  useEffect(() => {
    if (activeMode !== "quality") return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        findRef.current?.focus();
        findRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeMode]);

  const latest = runs[0] ?? null;
  const testBadge =
    liveRun != null
      ? { label: "running", cls: "bg-info/15 text-info" }
      : latest?.status === "failed"
        ? { label: `${latest.summary?.failed ?? "!"} failing`, cls: "bg-danger/15 text-danger" }
        : latest?.status === "passed"
          ? { label: "passing", cls: "bg-ok/15 text-ok" }
          : null;

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface-0">
      <header className="flex h-10 shrink-0 items-center border-b border-edge bg-surface-1 px-3">
        <ShieldCheck className="mr-2 h-4 w-4 text-crystal-300" />
        <span className="text-[13px] font-semibold text-ink">Quality</span>
        <div className="ml-3 flex w-60 items-center gap-1.5 rounded-lg border border-edge bg-surface-2 px-2 py-1">
          <Search className="h-3 w-3 shrink-0 text-ink-faint" />
          <input
            ref={findRef}
            value={find}
            onChange={(e) => nav({ quality: { find: e.target.value || null } })}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                nav({ quality: { find: null } });
                (e.target as HTMLInputElement).blur();
              }
            }}
            placeholder={view === "tests" ? "Find test files…" : "Find covered files…"}
            aria-label="Find across tests and coverage"
            className="w-full bg-transparent text-[11px] text-ink outline-none placeholder:text-ink-faint"
          />
          {find ? (
            <button
              type="button"
              onClick={() => nav({ quality: { find: null } })}
              aria-label="Clear find"
            >
              <X className="h-3 w-3 text-ink-faint hover:text-ink" />
            </button>
          ) : null}
        </div>
        <Tooltip content="Re-detect the runner and reload runs + coverage">
          <button
            type="button"
            onClick={refresh}
            aria-label="Refresh quality data"
            className="ml-2 rounded-md p-1 text-ink-faint hover:bg-surface-3 hover:text-ink"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
          </button>
        </Tooltip>
        <div className="ml-auto flex items-center gap-0.5 rounded-lg bg-surface-2 p-0.5">
          {VIEW_META.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => nav({ quality: { view: id } })}
              aria-pressed={view === id}
              className={cn(
                "flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium transition-colors",
                view === id ? "bg-surface-active text-ink" : "text-ink-muted hover:text-ink",
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {label}
              {id === "tests" && testBadge ? (
                <span className={cn("rounded-full px-1.5 font-mono text-[9px]", testBadge.cls)}>
                  {testBadge.label}
                </span>
              ) : null}
              {id === "tests" && !testBadge && info?.testFiles.length ? (
                <span className="rounded-full px-1 font-mono text-[9px] text-ink-faint">
                  {info.testFiles.length}
                </span>
              ) : null}
              {id === "coverage" && coverage ? (
                <span
                  className={cn(
                    "rounded-full px-1.5 font-mono text-[9px]",
                    coverage.total.lines.pct >= 80
                      ? "bg-ok/15 text-ok"
                      : coverage.total.lines.pct >= 50
                        ? "bg-warn/15 text-warn"
                        : "bg-danger/15 text-danger",
                  )}
                >
                  {coverage.total.lines.pct.toFixed(0)}%
                </span>
              ) : null}
            </button>
          ))}
        </div>
      </header>
      <div className="min-h-0 flex-1">
        {loading && !info ? (
          <div className="flex h-full items-center justify-center">
            <Spinner />
          </div>
        ) : view === "tests" ? (
          <TestsView />
        ) : (
          <CoverageView />
        )}
      </div>
    </div>
  );
}

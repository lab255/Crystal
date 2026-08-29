import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AppWindow,
  Component as ComponentIcon,
  Copy,
  Globe,
  MonitorPlay,
  MonitorX,
  Boxes,
} from "lucide-react";
import { componentForFile, containerForFile, fillRouteParams, missingRouteParams, routeParamNames } from "@crystal/core";
import type { C4ComponentModel, C4Model, RouteSamples, ScreenSource, ScreenSurface } from "@crystal/core";
import { useCrystal, useNav, useNavUpdate, useSymbolMenu, useWorkspaces } from "@crystal/client";
import {
  Badge,
  EmptyState,
  Pane as SplitPane,
  Split,
  Tooltip,
  cn,
  useContextMenu,
} from "@crystal/ui";
import {
  ApiCallsSection,
  DevServerPreview,
  DetailSection,
  FileLink,
  GroupHeader,
  LENS_DIM_CLASS,
  LensHint,
  ListHeader,
  copyText,
  useLiveDevUrls,
  useSurfaces,
  useSurfacesLens,
  type DevServerControl,
} from "./common.js";

/**
 * Screens — every navigable page of the frontend, detected from the router
 * (Next app/pages conventions, react-router configs) with a live preview when
 * a dev server is running. Selecting a screen deep-links
 * (`#/surfaces/screens?screen=…&demo=1`).
 */

const SOURCE_LABEL: Record<ScreenSource, string> = {
  "next-app": "Next.js · app router",
  "next-pages": "Next.js · pages",
  "react-router": "React Router",
  convention: "By convention",
};

const SOURCE_ORDER: ScreenSource[] = ["next-app", "next-pages", "react-router", "convention"];

export function ScreensView({ c4Model, c4Components }: { c4Model?: C4Model | null; c4Components?: C4ComponentModel | null }) {
  const { report } = useSurfaces();
  const nav = useNavUpdate();
  const selectedId = useNav((l) => l.surfaces?.screen ?? null);
  const demoOpen = useNav((l) => l.surfaces?.demo ?? false);
  const find = (useNav((l) => l.surfaces?.find) ?? "").trim().toLowerCase();
  const menu = useContextMenu();
  const symbolMenu = useSymbolMenu();
  const lens = useSurfacesLens();
  const [collapsed, setCollapsed] = useState<ReadonlySet<ScreenSource>>(new Set());

  const screens = report?.screens ?? [];
  const { app } = useLiveDevUrls();
  const { samples, saveSamples } = useRouteSamples();
  const appUrl = app.target?.availability === "live" ? app.target.url : null;

  /** Lens members (null when no lens dims) — non-members render dimmed. */
  const lensMembers = useMemo(
    () =>
      lens.active
        ? new Set(screens.filter((s) => lens.matcher.file(s.file)).map((s) => s.id))
        : null,
    [lens, screens],
  );

  const visible = useMemo(
    () =>
      screens.filter(
        (s) =>
          !find ||
          s.route.toLowerCase().includes(find) ||
          s.file.toLowerCase().includes(find) ||
          (s.component ?? "").toLowerCase().includes(find),
      ),
    [screens, find],
  );

  const groups = useMemo(() => {
    const bySource = new Map<ScreenSource, ScreenSurface[]>();
    for (const s of visible) {
      const list = bySource.get(s.source) ?? [];
      list.push(s);
      bySource.set(s.source, list);
    }
    return SOURCE_ORDER.filter((src) => bySource.has(src)).map((src) => ({
      source: src,
      screens: bySource.get(src)!,
    }));
  }, [visible]);

  const selected = screens.find((s) => s.id === selectedId) ?? null;

  if (screens.length === 0) {
    return (
      <EmptyState icon={AppWindow} title="No screens detected">
        Screens appear when the analyzer finds routed pages: Next.js `app/**/page.tsx` or
        `pages/**`, react-router `&lt;Route path&gt;` / `createBrowserRouter` configs, or exported
        components under a `pages/`, `screens/` or `views/` directory.
      </EmptyState>
    );
  }

  const rowMenu = (s: ScreenSurface): Parameters<typeof menu.open>[1] => {
    const file = s.componentFile ?? s.file;
    const containerId = c4Model ? containerForFile(c4Model, file) : null;
    const c4ComponentId = c4Components ? componentForFile(c4Components, file) : null;
    return [
    { type: "heading", label: s.route },
    ...(containerId && c4ComponentId
      ? [{
          type: "item" as const,
          label: "Show on architecture",
          icon: Boxes,
          onSelect: () => {
            nav({ mode: "architect", architect: {
              view: "architecture",
              level: "components",
              scope: containerId,
              sel: `node:${c4ComponentId}`,
            } });
          },
        }]
      : []),
    ...(s.component
      ? [
          {
            type: "item" as const,
            label: "Show component",
            icon: ComponentIcon,
            hint: s.component,
            onSelect: () =>
              nav({
                surfaces: {
                  view: "components",
                  component: `${s.componentFile ?? s.file}#${s.component}`,
                },
              }),
          },
        ]
      : []),
    ...(appUrl
      ? [
          {
            type: "item" as const,
            label: "Open live preview",
            icon: MonitorPlay,
            onSelect: () => nav({ surfaces: { screen: s.id, demo: true } }),
          },
          {
            type: "item" as const,
            label: "Open in browser",
            icon: Globe,
            onSelect: () => window.open(appUrl + s.route, "_blank", "noopener"),
          },
        ]
      : []),
    // The shared cross-view block for the page file (the component may live
    // elsewhere — its own row in the components view carries the symbol).
    ...symbolMenu({ file: s.file, line: s.line, label: s.route }),
    {
      type: "item",
      label: "Copy route",
      icon: Copy,
      hint: s.route,
      onSelect: () => copyText(s.route),
    },
    ...(appUrl
      ? [
          {
            type: "item" as const,
            label: "Copy URL",
            icon: Copy,
            onSelect: () => copyText(appUrl + s.route),
          },
        ]
      : []),
    ];
  };

  return (
    <Split storageKey="surfaces:screens" direction="horizontal">
      <SplitPane defaultSize={320} minSize={240} maxSize={520}>
        <aside className="flex h-full flex-col border-r border-edge bg-surface-1">
          <ListHeader icon={AppWindow} title="Screens" shown={visible.length} total={screens.length}>
            <LensHint lens={lens} matched={lensMembers?.size ?? 0} total={screens.length} />
          </ListHeader>
          <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
            {groups.map(({ source, screens: list }) => (
              <div key={source} className="mb-1.5">
                <GroupHeader
                  label={SOURCE_LABEL[source]}
                  count={list.length}
                  collapsed={collapsed.has(source)}
                  onToggle={() =>
                    setCollapsed((c) => {
                      const next = new Set(c);
                      if (next.has(source)) next.delete(source);
                      else next.add(source);
                      return next;
                    })
                  }
                />
                {!collapsed.has(source)
                  ? list.map((s) => (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() => nav({ surfaces: { screen: s.id } })}
                        onContextMenu={(e) => menu.open(e, rowMenu(s))}
                        className={cn(
                          "flex w-full items-center gap-1.5 rounded-lg px-2 py-1 text-left",
                          selected?.id === s.id
                            ? "bg-crystal-500/15 text-ink"
                            : "text-ink-muted hover:bg-surface-2 hover:text-ink",
                          lensMembers && !lensMembers.has(s.id) && LENS_DIM_CLASS,
                        )}
                      >
                        <span className="min-w-0 flex-1 truncate font-mono text-[10.5px]">
                          {s.route}
                        </span>
                        {s.component ? (
                          <span className="max-w-24 shrink-0 truncate text-[9.5px] text-ink-faint">
                            {s.component}
                          </span>
                        ) : null}
                      </button>
                    ))
                  : null}
              </div>
            ))}
            {visible.length === 0 ? (
              <div className="px-3 py-6 text-center text-[11px] text-ink-faint">
                Nothing matches the current filter.
              </div>
            ) : null}
          </div>
        </aside>
      </SplitPane>
      <SplitPane minSize="40%">
        {selected ? (
          <ScreenDetail
            key={selected.id}
            screen={selected}
            app={app}
            demoOpen={demoOpen}
            onToggleDemo={(open) => nav({ surfaces: { demo: open } })}
            samples={samples[selected.route]}
            onSaveSamples={(params) => saveSamples(selected.route, params)}
          />
        ) : (
          <EmptyState icon={AppWindow} title="Pick a screen">
            The route, its component, and — when your dev server is running — a live preview.
          </EmptyState>
        )}
      </SplitPane>
      {menu.element}
    </Split>
  );
}

/**
 * Saved samples for parameterised routes (`.crystal/surfaces.json`), kept in
 * step with other windows via `surfaces.samplesChanged`.
 */
function useRouteSamples(): {
  samples: RouteSamples;
  saveSamples: (route: string, params: Record<string, string>) => Promise<void>;
} {
  const { client } = useCrystal();
  const activeWs = useWorkspaces((s) => s.activeId);
  const [samples, setSamples] = useState<RouteSamples>({});
  useEffect(() => {
    if (!activeWs) return;
    let alive = true;
    setSamples({});
    client
      .request("surfaces.samples.get", {})
      .then(({ routes }) => {
        if (alive) setSamples(routes);
      })
      .catch(() => {});
    const off = client.events.on("surfaces.samplesChanged", ({ ws, routes }) => {
      if (ws === activeWs) setSamples(routes);
    });
    return () => {
      alive = false;
      off();
    };
  }, [client, activeWs]);
  const saveSamples = useCallback(
    async (route: string, params: Record<string, string>) => {
      const { routes } = await client.request("surfaces.samples.set", { route, params });
      setSamples(routes);
    },
    [client],
  );
  return { samples, saveSamples };
}

/** One input per route param; a value is saved on Enter or blur. */
function RouteParamsEditor({
  route,
  samples,
  onSave,
}: {
  route: string;
  samples: Record<string, string> | undefined;
  onSave: (params: Record<string, string>) => void;
}) {
  const names = routeParamNames(route);
  const [draft, setDraft] = useState<Record<string, string>>(() => ({ ...(samples ?? {}) }));
  useEffect(() => setDraft({ ...(samples ?? {}) }), [samples]);
  const commit = () => {
    const next = Object.fromEntries(names.map((n) => [n, draft[n] ?? ""]));
    const prev = Object.fromEntries(names.map((n) => [n, samples?.[n] ?? ""]));
    if (JSON.stringify(next) !== JSON.stringify(prev)) onSave(next);
  };
  if (names.length === 0) return null;
  const missing = missingRouteParams(route, samples);
  return (
    <div className="mb-2 rounded-lg border border-edge bg-surface-2/60 p-2">
      <div className="mb-1 flex items-center justify-between text-[10px] text-ink-faint">
        <span>Route parameters — sample values, saved to <code>.crystal/surfaces.json</code></span>
        {missing.length > 0 ? <span className="text-warn">{missing.length} missing</span> : null}
      </div>
      <div className="grid grid-cols-[auto_1fr] items-center gap-x-2 gap-y-1">
        {names.map((n) => (
          <label key={n} className="contents">
            <span className="font-mono text-[10.5px] text-ink-muted">{n === "*" ? "*" : `:${n}`}</span>
            <input
              value={draft[n] ?? ""}
              onChange={(e) => setDraft((d) => ({ ...d, [n]: e.target.value }))}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              }}
              placeholder={n === "*" ? "rest/of/path" : "value"}
              spellCheck={false}
              aria-label={`Sample value for ${n}`}
              className="min-w-0 rounded-md border border-edge bg-surface-1 px-1.5 py-0.5 font-mono text-[10.5px] text-ink outline-none focus:border-crystal-500"
            />
          </label>
        ))}
      </div>
    </div>
  );
}

function ScreenDetail({
  screen,
  app,
  demoOpen,
  onToggleDemo,
  samples,
  onSaveSamples,
}: {
  screen: ScreenSurface;
  app: DevServerControl;
  demoOpen: boolean;
  onToggleDemo: (open: boolean) => void;
  samples: Record<string, string> | undefined;
  onSaveSamples: (params: Record<string, string>) => void;
}) {
  const nav = useNavUpdate();
  const hasParams = routeParamNames(screen.route).length > 0;
  const unfilled = missingRouteParams(screen.route, samples);
  const live = app.target?.availability === "live";
  const defaultUrl = app.target ? app.target.url + fillRouteParams(screen.route, samples) : null;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-surface-0">
      <div className="border-b border-edge bg-surface-1 px-4 py-3">
        <div className="flex items-center gap-2">
          <AppWindow className="h-4 w-4 shrink-0 text-accent-cyan" />
          <span className="min-w-0 flex-1 break-all font-mono text-[13px] font-semibold text-ink">
            {screen.route}
          </span>
          <Badge tone="slate">{SOURCE_LABEL[screen.source]}</Badge>
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px] text-ink-muted">
          {screen.component ? (
            <Tooltip content="Show in the components view">
              <button
                type="button"
                onClick={() =>
                  nav({
                    surfaces: {
                      view: "components",
                      component: `${screen.componentFile ?? screen.file}#${screen.component}`,
                    },
                  })
                }
                className="flex items-center gap-1 rounded-md border border-edge bg-surface-2 px-1.5 py-0.5 hover:text-ink"
              >
                <ComponentIcon className="h-3 w-3 text-accent-violet" />
                {screen.component}
              </button>
            </Tooltip>
          ) : null}
          <FileLink file={screen.file} line={screen.line} />
        </div>
      </div>

      <DetailSection
        title="Live preview"
        hint={
          live
            ? `dev server detected at ${app.target!.url}`
            : app.target
              ? `expected at ${app.target.url} — not responding`
              : "start your dev server to embed the running screen here"
        }
        actions={
          live ? (
            <button
              type="button"
              onClick={() => onToggleDemo(!demoOpen)}
              aria-pressed={demoOpen}
              className="flex items-center gap-1 text-[10px] text-ink-faint hover:text-ink"
            >
              {demoOpen ? <MonitorX className="h-3 w-3" /> : <MonitorPlay className="h-3 w-3" />}
              {demoOpen ? "close" : "open"}
            </button>
          ) : undefined
        }
      >
        {hasParams ? (
          <RouteParamsEditor route={screen.route} samples={samples} onSave={onSaveSamples} />
        ) : null}
        <DevServerPreview
          control={app}
          url={defaultUrl}
          title={`Preview of ${screen.route}`}
          hint={
            demoOpen && unfilled.length > 0 ? (
              <div className="text-[10px] text-warn">
                Missing sample value{unfilled.length > 1 ? "s" : ""} for{" "}
                {unfilled.map((n) => <code key={n}>:{n} </code>)}— fill them above to preview this route.
              </div>
            ) : (
              `Preview ${screen.route} live`
            )
          }
          open={demoOpen}
          onOpenChange={onToggleDemo}
          manualUrl
        />
      </DetailSection>

      <DetailSection title="Source" hint="where this screen is declared">
        <div className="space-y-1 text-[11px] text-ink-muted">
          <div className="flex items-center gap-2">
            <span className="w-20 shrink-0 text-[10px] uppercase tracking-wider text-ink-faint">
              Route file
            </span>
            <FileLink file={screen.file} line={screen.line} />
          </div>
          {screen.componentFile && screen.componentFile !== screen.file ? (
            <div className="flex items-center gap-2">
              <span className="w-20 shrink-0 text-[10px] uppercase tracking-wider text-ink-faint">
                Component
              </span>
              <FileLink file={screen.componentFile} />
            </div>
          ) : null}
        </div>
      </DetailSection>

      {/* The screen's backend story: API calls its component graph reaches. */}
      <ApiCallsSection
        file={screen.componentFile ?? screen.file}
        symbol={screen.component}
      />
    </div>
  );
}

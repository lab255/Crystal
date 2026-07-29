import { useEffect, useMemo, useState } from "react";
import {
  AppWindow,
  Component as ComponentIcon,
  Copy,
  Globe,
  MonitorPlay,
  MonitorX,
  RefreshCw,
} from "lucide-react";
import type { ScreenSource, ScreenSurface } from "@crystal/core";
import { useNav, useNavUpdate, useSymbolMenu } from "@crystal/client";
import { Badge, EmptyState, Pane as SplitPane, Split, Tooltip, cn, useContextMenu } from "@crystal/ui";
import {
  ApiCallsSection,
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

export function ScreensView() {
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
  const { appUrl } = useLiveDevUrls();

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

  const rowMenu = (s: ScreenSurface): Parameters<typeof menu.open>[1] => [
    { type: "heading", label: s.route },
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
            appUrl={appUrl}
            demoOpen={demoOpen}
            onToggleDemo={(open) => nav({ surfaces: { demo: open } })}
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

function ScreenDetail({
  screen,
  appUrl,
  demoOpen,
  onToggleDemo,
}: {
  screen: ScreenSurface;
  appUrl: string | null;
  demoOpen: boolean;
  onToggleDemo: (open: boolean) => void;
}) {
  const nav = useNavUpdate();
  const hasParams = /[:*]/.test(screen.route);
  const defaultUrl = appUrl ? appUrl + screen.route : null;
  const [url, setUrl] = useState(defaultUrl ?? "");
  const [frameNonce, setFrameNonce] = useState(0);
  useEffect(() => setUrl(defaultUrl ?? ""), [defaultUrl]);

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
          appUrl
            ? `dev server detected at ${appUrl}`
            : "start your dev server to embed the running screen here"
        }
        actions={
          appUrl ? (
            <div className="flex items-center gap-2">
              {demoOpen ? (
                <button
                  type="button"
                  onClick={() => setFrameNonce((n) => n + 1)}
                  className="flex items-center gap-1 text-[10px] text-ink-faint hover:text-ink"
                >
                  <RefreshCw className="h-3 w-3" /> reload
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => onToggleDemo(!demoOpen)}
                aria-pressed={demoOpen}
                className="flex items-center gap-1 text-[10px] text-ink-faint hover:text-ink"
              >
                {demoOpen ? <MonitorX className="h-3 w-3" /> : <MonitorPlay className="h-3 w-3" />}
                {demoOpen ? "close" : "open"}
              </button>
            </div>
          ) : undefined
        }
      >
        {!appUrl ? (
          <div className="text-[11px] text-ink-faint">
            No dev server detected in this workspace's package.json scripts. Run it (e.g.{" "}
            <code className="text-ink-muted">pnpm dev</code>) and the preview embeds here.
          </div>
        ) : !demoOpen ? (
          <button
            type="button"
            onClick={() => onToggleDemo(true)}
            className="flex items-center gap-1.5 rounded-lg border border-edge bg-surface-2 px-2.5 py-1.5 text-[11px] text-ink-muted hover:text-ink"
          >
            <MonitorPlay className="h-3.5 w-3.5 text-ok" /> Preview {screen.route} live
          </button>
        ) : (
          <div className="space-y-1.5">
            <div className="flex items-center gap-1.5">
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") setFrameNonce((n) => n + 1);
                }}
                spellCheck={false}
                aria-label="Preview URL"
                className="min-w-0 flex-1 rounded-lg border border-edge bg-surface-1 px-2 py-1 font-mono text-[10.5px] text-ink outline-none focus:border-crystal-500/60"
              />
              <Tooltip content="Open in browser">
                <button
                  type="button"
                  onClick={() => window.open(url, "_blank", "noopener")}
                  className="rounded-md border border-edge bg-surface-2 p-1 text-ink-muted hover:text-ink"
                  aria-label="Open in browser"
                >
                  <Globe className="h-3.5 w-3.5" />
                </button>
              </Tooltip>
            </div>
            {hasParams ? (
              <div className="text-[10px] text-warn">
                This route has parameters — replace <code>:param</code> segments in the URL above.
              </div>
            ) : null}
            <iframe
              key={frameNonce}
              src={url}
              title={`Preview of ${screen.route}`}
              className="h-[28rem] w-full rounded-lg border border-edge bg-white"
              sandbox="allow-scripts allow-same-origin allow-forms"
            />
          </div>
        )}
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

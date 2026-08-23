import { useEffect, useMemo, useRef, useState } from "react";
import {
  AppWindow,
  BookOpenText,
  Boxes,
  ChevronDown,
  Component as ComponentIcon,
  Copy,
  ExternalLink,
  Globe,
  Import,
  MonitorPlay,
} from "lucide-react";
import { componentForFile, containerForFile, roleOfFile, storybookStorySlug } from "@crystal/core";
import type { C4ComponentModel, C4Model, CodeRole, CodeSymbolSites, CodeSymbolSource, ComponentSurface, SystemModule } from "@crystal/core";
import { requestOpenFile, useCrystal, useNav, useNavUpdate, useSymbolMenu } from "@crystal/client";
import {
  Badge,
  CodeSnippet,
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
  groupComponentsBySystem,
  storybookStoryUrl,
  useArchHighlight,
  useLiveDevUrls,
  useSurfaces,
  useSurfacesLens,
  type LiveDevUrls,
} from "./common.js";

/**
 * Components — the reusable frontend surface: every exported React component,
 * ranked by usage breadth, cross-linked to its stories, the screens that
 * render it, its definition and every consumer.
 */

const componentId = (c: ComponentSurface): string => `${c.file}#${c.name}`;

const ROLE_LABEL: Partial<Record<CodeRole, string>> = {
  provider: "provider",
  layout: "layout",
  query: "query",
};

function roleLabelOf(file: string, componentRole: CodeRole | undefined, system: SystemModule | null): string | null {
  const prefixes = system
    ? [...system.parts.flatMap((part) => [part.path, part.pkg])]
        .filter((prefix) => file === prefix || file.startsWith(`${prefix}/`))
        .sort((a, b) => b.length - a.length)
    : [];
  const prefix = prefixes[0];
  const relativeFile = prefix ? file.slice(prefix.length).replace(/^\//, "") : file;
  const role = componentRole ?? roleOfFile(relativeFile, "frontend");
  if (role === "component") return /(^|[/._-])hooks?([/._-]|$)/i.test(file) ? "hook" : null;
  return ROLE_LABEL[role] ?? null;
}

/** `import { Button } from "./components/Button"` for the copy menu. */
function importStatementOf(c: ComponentSurface): string {
  const spec = c.file.replace(/\.(tsx|ts|jsx|js)$/, "");
  return `import { ${c.name} } from "${spec}";`;
}

export function ComponentsView({ c4Model, c4Components }: { c4Model?: C4Model | null; c4Components?: C4ComponentModel | null }) {
  const { report, systemOfFile } = useSurfaces();
  const nav = useNavUpdate();
  const selectedId = useNav((l) => l.surfaces?.component ?? null);
  const find = (useNav((l) => l.surfaces?.find) ?? "").trim().toLowerCase();
  const menu = useContextMenu();
  const symbolMenu = useSymbolMenu();
  const lens = useSurfacesLens();
  const servers = useLiveDevUrls();
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const previewRef = useRef<HTMLDivElement>(null);

  const components = report?.components ?? [];
  /** Lens members (null when no lens dims) — non-members render dimmed. */
  const lensMembers = useMemo(
    () =>
      lens.active
        ? new Set(
            components.filter((c) => lens.matcher.file(c.file)).map((c) => componentId(c)),
          )
        : null,
    [lens, components],
  );
  const findMembers = useMemo(
    () => new Set(components.filter((c) => !find || c.name.toLowerCase().includes(find) || c.file.toLowerCase().includes(find)).map(componentId)),
    [components, find],
  );
  const groups = useMemo(
    () => groupComponentsBySystem(components, systemOfFile),
    [components, systemOfFile],
  );
  const selected = components.find((c) => componentId(c) === selectedId) ?? null;
  const componentRoleOfFile = useMemo(() => {
    const byId = new Map(
      Object.values(c4Components?.byContainer ?? {}).flat().map((component) => [component.id, component.role]),
    );
    return (file: string) => byId.get(c4Components?.componentOfFile[file] ?? "");
  }, [c4Components]);

  useEffect(() => {
    if (!selected) return;
    const groupId = systemOfFile(selected.file)?.id ?? "__other__";
    setCollapsed((current) => {
      if (!current.has(groupId)) return current;
      const next = new Set(current);
      next.delete(groupId);
      return next;
    });
  }, [selectedId, selected, systemOfFile]);

  const focusPreview = (c: ComponentSurface) => {
    nav({ surfaces: { component: componentId(c) } });
    requestAnimationFrame(() => previewRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };

  if (components.length === 0) {
    return (
      <EmptyState icon={ComponentIcon} title="No components detected">
        Exported React components (uppercase functions returning JSX) appear here, ranked by how
        many files import them.
      </EmptyState>
    );
  }

  const rowMenu = (c: ComponentSurface): Parameters<typeof menu.open>[1] => {
    const containerId = c4Model ? containerForFile(c4Model, c.file) : null;
    const c4ComponentId = c4Components ? componentForFile(c4Components, c.file) : null;
    return [
    { type: "heading", label: c.name },
    ...(containerId && c4ComponentId
      ? [{
          type: "item" as const,
          label: "Show on architecture",
          icon: Boxes,
          onSelect: () => nav({
            mode: "architect",
            architect: {
              view: "architecture",
              level: "components",
              scope: containerId,
              sel: `node:${c4ComponentId}`,
            },
          }),
        }]
      : []),
    ...(c.stories.length > 0 || c.screens.length > 0
      ? [
          {
            type: "item" as const,
            label: "Open live preview",
            icon: MonitorPlay,
            onSelect: () => focusPreview(c),
          },
        ]
      : []),
    ...(c.stories.length > 0 && servers.storybook.target?.availability === "live"
      ? [
          {
            type: "item" as const,
            label: "Open story in Storybook",
            icon: Globe,
            onSelect: () => {
              const story = report?.stories.find((item) => item.id === c.stories[0]);
              if (story)
                window.open(
                  `${servers.storybook.target!.url}/?path=/story/${storybookStorySlug(story.title, story.name)}`,
                  "_blank",
                  "noopener",
                );
            },
          },
        ]
      : []),
    ...(c.stories.length > 0
      ? [
          {
            type: "item" as const,
            label: "Show stories",
            icon: BookOpenText,
            hint: `${c.stories.length}`,
            onSelect: () => nav({ surfaces: { view: "stories", story: c.stories[0] } }),
          },
        ]
      : []),
    ...(c.screens.length > 0
      ? [
          {
            type: "item" as const,
            label: "Show screen",
            icon: AppWindow,
            hint: `${c.screens.length}`,
            onSelect: () => nav({ surfaces: { view: "screens", screen: c.screens[0] } }),
          },
        ]
      : []),
    // The shared cross-view block: pin, editor, code map, coverage, copy.
    ...symbolMenu({ file: c.file, line: c.line, symbol: c.name, label: c.name }),
    {
      type: "item",
      label: "Copy import statement",
      icon: Import,
      onSelect: () => copyText(importStatementOf(c)),
    },
    ];
  };

  return (
    <Split storageKey="surfaces:components" direction="horizontal">
      <SplitPane defaultSize={320} minSize={240} maxSize={520}>
        <aside className="flex h-full flex-col border-r border-edge bg-surface-1">
          <ListHeader
            icon={ComponentIcon}
            title="Components"
            shown={findMembers.size}
            total={components.length}
          >
            <LensHint lens={lens} matched={lensMembers?.size ?? 0} total={components.length} />
          </ListHeader>
          <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
            {groups.map((group) => (
              <div key={group.id} className="mb-1.5">
                <GroupHeader
                  label={group.name}
                  count={group.components.length}
                  collapsed={collapsed.has(group.id)}
                  onToggle={() =>
                    setCollapsed((current) => {
                      const next = new Set(current);
                      if (next.has(group.id)) next.delete(group.id);
                      else next.add(group.id);
                      return next;
                    })
                  }
                />
                {!collapsed.has(group.id)
                  ? group.components.map((c) => {
                      const id = componentId(c);
                      const roleLabel = roleLabelOf(c.file, componentRoleOfFile(c.file), systemOfFile(c.file));
                      return (
                        <button
                          key={id}
                          type="button"
                          onClick={() => nav({ surfaces: { component: id } })}
                          onContextMenu={(e) => menu.open(e, rowMenu(c))}
                          className={cn(
                            "flex w-full items-center gap-1.5 rounded-lg px-2 py-1 text-left",
                            selected === c
                              ? "bg-crystal-500/15 text-ink"
                              : "text-ink-muted hover:bg-surface-2 hover:text-ink",
                            lensMembers && !lensMembers.has(id) && LENS_DIM_CLASS,
                            !findMembers.has(id) && LENS_DIM_CLASS,
                          )}
                        >
                          <span className="min-w-0 flex-1 truncate text-[11px] font-medium">
                            {c.name}
                          </span>
                          {roleLabel ? (
                            <span className="shrink-0 rounded bg-surface-3 px-1 text-[8.5px] uppercase text-ink-faint">
                              {roleLabel}
                            </span>
                          ) : null}
                          {c.stories.length > 0 ? (
                            <Tooltip
                              content={`${c.stories.length} stor${c.stories.length === 1 ? "y" : "ies"}`}
                            >
                              <BookOpenText className="h-3 w-3 shrink-0 text-accent-amber" />
                            </Tooltip>
                          ) : null}
                          {c.screens.length > 0 ? (
                            <Tooltip
                              content={`rendered by ${c.screens.length} screen${c.screens.length === 1 ? "" : "s"}`}
                            >
                              <AppWindow className="h-3 w-3 shrink-0 text-accent-cyan" />
                            </Tooltip>
                          ) : null}
                          <Tooltip
                            content={`imported by ${c.usedBy} file${c.usedBy === 1 ? "" : "s"}`}
                          >
                            <span className="w-7 shrink-0 text-right font-mono text-[9.5px] text-ink-faint">
                              ×{c.usedBy}
                            </span>
                          </Tooltip>
                        </button>
                      );
                    })
                  : null}
              </div>
            ))}
          </div>
        </aside>
      </SplitPane>
      <SplitPane minSize="40%">
        {selected ? (
          <ComponentDetail
            key={componentId(selected)}
            component={selected}
            previewRef={previewRef}
            servers={servers}
          />
        ) : (
          <EmptyState icon={ComponentIcon} title="Pick a component">
            Props signature, definition, its stories and screens, and everywhere it's used.
          </EmptyState>
        )}
      </SplitPane>
      {menu.element}
    </Split>
  );
}

const SNIPPET_COLLAPSED_LINES = 18;

function ComponentDetail({
  component: c,
  previewRef,
  servers,
}: {
  component: ComponentSurface;
  previewRef: React.RefObject<HTMLDivElement | null>;
  servers: LiveDevUrls;
}) {
  const { client } = useCrystal();
  const { report, systemOfFile } = useSurfaces();
  const arch = useArchHighlight();
  const nav = useNavUpdate();
  const [source, setSource] = useState<CodeSymbolSource | null>(null);
  const [sites, setSites] = useState<CodeSymbolSites | null>(null);
  const [snippetOpen, setSnippetOpen] = useState(false);
  const { app, storybook } = servers;
  const [storyId, setStoryId] = useState(c.stories[0] ?? "");
  const [screenId, setScreenId] = useState(c.screens[0] ?? "");

  useEffect(() => {
    let cancelled = false;
    client
      .request("codemap.symbolSource", { file: c.file, symbol: c.name })
      .then((s) => !cancelled && setSource(s))
      .catch(() => {});
    client
      .request("codemap.symbolSites", { file: c.file, symbol: c.name })
      .then((s) => !cancelled && setSites(s))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [client, c.file, c.name]);

  const stories = c.stories
    .map((id) => report?.stories.find((story) => story.id === id))
    .filter((story): story is NonNullable<typeof story> => story != null);
  const screens = c.screens
    .map((id) => report?.screens.find((screen) => screen.id === id))
    .filter((screen): screen is NonNullable<typeof screen> => screen != null);
  const previewStory = stories.find((story) => story.id === storyId) ?? stories[0] ?? null;
  const previewScreen = screens.find((screen) => screen.id === screenId) ?? screens[0] ?? null;
  const storyUrl =
    previewStory && storybook.target
      ? storybookStoryUrl(storybook.target.url, previewStory.title, previewStory.name)
      : null;
  const screenUrl = previewScreen && app.target ? app.target.url + previewScreen.route : null;

  const snippetLines = source?.text.split("\n") ?? null;
  const clipped =
    snippetLines != null && !snippetOpen && snippetLines.length > SNIPPET_COLLAPSED_LINES;
  const shown = clipped
    ? snippetLines!.slice(0, SNIPPET_COLLAPSED_LINES).join("\n")
    : (source?.text ?? "");

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-surface-0">
      <div className="border-b border-edge bg-surface-1 px-4 py-3">
        <div className="flex items-center gap-2">
          <ComponentIcon className="h-4 w-4 shrink-0 text-accent-violet" />
          <span className="min-w-0 flex-1 truncate font-mono text-[13px] font-semibold text-ink">
            {c.name}
          </span>
          <Badge tone="neutral">×{c.usedBy} usages</Badge>
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px] text-ink-muted">
          <FileLink file={c.file} line={c.line} />
          {systemOfFile(c.file) ? (
            <Tooltip content="Highlight this component in the architecture pane">
              <button
                type="button"
                onClick={() => arch.symbol(c.file, c.name, c.line)}
                className="flex items-center gap-1 rounded-md border border-edge bg-surface-2 px-1.5 py-0.5 text-[10px] hover:text-ink"
              >
                <Boxes className="h-3 w-3 text-crystal-300" />
                {systemOfFile(c.file)!.name}
              </button>
            </Tooltip>
          ) : null}
        </div>
        {c.signature ? (
          <div className="mt-1.5 truncate font-mono text-[10.5px] text-ink-faint" title={c.signature}>
            {c.signature}
          </div>
        ) : null}
      </div>

      {stories.length > 0 || screens.length > 0 ? (
        <DetailSection title="Appears in" hint="stories and routed screens rendering this component">
          <div className="flex flex-wrap items-center gap-1.5">
            {stories.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => nav({ surfaces: { view: "stories", story: s.id } })}
                className="flex items-center gap-1 rounded-full border border-accent-amber/40 bg-accent-amber/10 px-2 py-0.5 text-[10px] text-accent-amber hover:brightness-110"
                title="Open in the stories view"
              >
                <BookOpenText className="h-3 w-3" />
                {s.title} / {s.name}
              </button>
            ))}
            {screens.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => nav({ surfaces: { view: "screens", screen: s.id } })}
                className="flex items-center gap-1 rounded-full border border-accent-cyan/40 bg-accent-cyan/10 px-2 py-0.5 text-[10px] text-accent-cyan hover:brightness-110"
                title="Open in the screens view"
              >
                <AppWindow className="h-3 w-3" />
                {s.route}
              </button>
            ))}
          </div>
        </DetailSection>
      ) : null}

      <div ref={previewRef}>
        <DetailSection
          title="Live preview"
          hint={
            previewStory
              ? "the component's first linked story"
              : previewScreen
                ? `route ${previewScreen.route}`
                : "start a dev server when a story or route is added"
          }
        >
          {previewStory ? (
            <div className="space-y-2">
              {stories.length > 1 ? (
                <select
                  value={previewStory.id}
                  onChange={(event) => setStoryId(event.target.value)}
                  aria-label="Preview story"
                  className="rounded-lg border border-edge bg-surface-1 px-2 py-1 text-[10.5px] text-ink outline-none"
                >
                  {stories.map((story) => (
                    <option key={story.id} value={story.id}>{story.title} / {story.name}</option>
                  ))}
                </select>
              ) : null}
              <DevServerPreview
                control={storybook}
                url={storyUrl}
                title={`Storybook render of ${previewStory.title}/${previewStory.name}`}
                hint={`Render ${previewStory.name} live`}
                kind="storybook"
              />
            </div>
          ) : previewScreen ? (
            <div className="space-y-2">
              {screens.length > 1 ? (
                <select
                  value={previewScreen.id}
                  onChange={(event) => setScreenId(event.target.value)}
                  aria-label="Preview screen"
                  className="rounded-lg border border-edge bg-surface-1 px-2 py-1 text-[10.5px] text-ink outline-none"
                >
                  {screens.map((screen) => <option key={screen.id} value={screen.id}>{screen.route}</option>)}
                </select>
              ) : null}
              <div className="text-[10.5px] text-ink-faint">
                previewing route <code className="text-ink-muted">{previewScreen.route}</code>, which
                renders <span className="text-ink-muted">{c.name}</span>
              </div>
              <DevServerPreview
                control={app}
                url={screenUrl}
                title={`Preview of ${c.name} on ${previewScreen.route}`}
                hint={`Preview ${previewScreen.route} live`}
              />
            </div>
          ) : (
            <div className="space-y-2">
              {app.target?.availability === "live" ? null : (
                <div className="text-[11px] text-ink-faint">
                  No story or routed screen renders {c.name}
                </div>
              )}
              <DevServerPreview
                control={app}
                url={null}
                title={`Preview of ${c.name}`}
                hint={`Preview ${c.name} live`}
                noUrlHint={<>No story or routed screen renders {c.name}</>}
              />
            </div>
          )}
        </DetailSection>
      </div>

      <DetailSection
        title="Definition"
        actions={
          source ? (
            <button
              type="button"
              onClick={() => requestOpenFile(source.file, source.startLine)}
              className="flex items-center gap-1 text-[10px] text-ink-faint hover:text-ink"
            >
              <ExternalLink className="h-3 w-3" /> open
            </button>
          ) : undefined
        }
      >
        {source ? (
          <>
            <CodeSnippet code={shown} startLine={source.startLine} truncated={source.truncated && !clipped} />
            {snippetLines && snippetLines.length > SNIPPET_COLLAPSED_LINES ? (
              <button
                type="button"
                onClick={() => setSnippetOpen((o) => !o)}
                className="mt-1 flex items-center gap-1 text-[10px] text-ink-faint hover:text-ink"
                aria-expanded={snippetOpen}
              >
                <ChevronDown
                  className={cn("h-3 w-3 transition-transform", snippetOpen && "rotate-180")}
                />
                {snippetOpen ? "Collapse" : `Show all ${snippetLines.length} lines`}
              </button>
            ) : null}
          </>
        ) : (
          <div className="text-[11px] text-ink-faint">Loading…</div>
        )}
      </DetailSection>

      <ApiCallsSection file={c.file} symbol={c.name} />

      <DetailSection
        title={`Used by · ${sites ? sites.imports.length : "…"}`}
        hint="import sites bringing this component in (barrel re-exports followed)"
      >
        {sites == null ? (
          <div className="text-[11px] text-ink-faint">Scanning…</div>
        ) : sites.imports.length === 0 ? (
          <div className="text-[11px] text-ink-faint">
            No imports found — it may only be used in its own file (or through a pattern the
            analyzer can't see).
          </div>
        ) : (
          <div className="space-y-0.5">
            {sites.imports.map((site, i) => (
              <div
                key={`${site.file}:${site.line ?? 0}:${i}`}
                role="button"
                tabIndex={0}
                onClick={() => arch.file(site.file, site.line ?? undefined)}
                onDoubleClick={() => requestOpenFile(site.file, site.line ?? undefined)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") arch.file(site.file, site.line ?? undefined);
                }}
                title="Click: highlight the importing system in the architecture pane · double-click: open the code"
                className="flex w-full cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 text-left hover:bg-surface-2"
              >
                <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-ink-muted">
                  {site.text ?? site.file}
                </span>
                <span className="ml-auto flex min-w-0 shrink-0 items-center gap-1 font-mono text-[9.5px] text-ink-faint">
                  <span className="max-w-52 truncate">
                    {site.file}
                    {site.line != null ? `:${site.line}` : ""}
                  </span>
                  {systemOfFile(site.file) ? (
                    <span className="rounded bg-surface-3 px-1 text-[8.5px] uppercase">
                      {systemOfFile(site.file)!.name}
                    </span>
                  ) : null}
                </span>
                <Tooltip content="View in code">
                  <button
                    type="button"
                    aria-label={`Open ${site.file} in the editor`}
                    onClick={(e) => {
                      e.stopPropagation();
                      requestOpenFile(site.file, site.line ?? undefined);
                    }}
                    className="shrink-0 rounded p-0.5 text-ink-faint hover:bg-surface-3 hover:text-ink"
                  >
                    <ExternalLink className="h-3 w-3" />
                  </button>
                </Tooltip>
              </div>
            ))}
            {sites.truncated ? (
              <div className="px-1.5 pt-1 text-[10px] text-ink-faint">List capped by the server.</div>
            ) : null}
          </div>
        )}
      </DetailSection>
    </div>
  );
}

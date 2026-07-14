import { useEffect, useMemo, useState } from "react";
import {
  AppWindow,
  BookOpenText,
  Boxes,
  ChevronDown,
  Component as ComponentIcon,
  Copy,
  ExternalLink,
  Import,
} from "lucide-react";
import type { CodeSymbolSites, CodeSymbolSource, ComponentSurface } from "@crystal/core";
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
  DetailSection,
  FileLink,
  ListHeader,
  copyText,
  useArchHighlight,
  useSurfaces,
} from "./common.js";

/**
 * Components — the reusable frontend surface: every exported React component,
 * ranked by usage breadth, cross-linked to its stories, the screens that
 * render it, its definition and every consumer.
 */

const componentId = (c: ComponentSurface): string => `${c.file}#${c.name}`;

/** `import { Button } from "./components/Button"` for the copy menu. */
function importStatementOf(c: ComponentSurface): string {
  const spec = c.file.replace(/\.(tsx|ts|jsx|js)$/, "");
  return `import { ${c.name} } from "${spec}";`;
}

export function ComponentsView() {
  const { report } = useSurfaces();
  const nav = useNavUpdate();
  const selectedId = useNav((l) => l.surfaces?.component ?? null);
  const find = (useNav((l) => l.surfaces?.find) ?? "").trim().toLowerCase();
  const menu = useContextMenu();
  const symbolMenu = useSymbolMenu();

  const components = report?.components ?? [];
  const visible = useMemo(
    () =>
      components.filter(
        (c) => !find || c.name.toLowerCase().includes(find) || c.file.toLowerCase().includes(find),
      ),
    [components, find],
  );
  const selected = components.find((c) => componentId(c) === selectedId) ?? null;

  if (components.length === 0) {
    return (
      <EmptyState icon={ComponentIcon} title="No components detected">
        Exported React components (uppercase functions returning JSX) appear here, ranked by how
        many files import them.
      </EmptyState>
    );
  }

  const rowMenu = (c: ComponentSurface): Parameters<typeof menu.open>[1] => [
    { type: "heading", label: c.name },
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

  return (
    <Split storageKey="surfaces:components" direction="horizontal">
      <SplitPane defaultSize={320} minSize={240} maxSize={520}>
        <aside className="flex h-full flex-col border-r border-edge bg-surface-1">
          <ListHeader
            icon={ComponentIcon}
            title="Components"
            shown={visible.length}
            total={components.length}
          />
          <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
            {visible.map((c) => {
              const id = componentId(c);
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
                  )}
                >
                  <span className="min-w-0 flex-1 truncate text-[11px] font-medium">{c.name}</span>
                  {c.stories.length > 0 ? (
                    <Tooltip content={`${c.stories.length} stor${c.stories.length === 1 ? "y" : "ies"}`}>
                      <BookOpenText className="h-3 w-3 shrink-0 text-accent-amber" />
                    </Tooltip>
                  ) : null}
                  {c.screens.length > 0 ? (
                    <Tooltip content={`rendered by ${c.screens.length} screen${c.screens.length === 1 ? "" : "s"}`}>
                      <AppWindow className="h-3 w-3 shrink-0 text-accent-cyan" />
                    </Tooltip>
                  ) : null}
                  <Tooltip content={`imported by ${c.usedBy} file${c.usedBy === 1 ? "" : "s"}`}>
                    <span className="w-7 shrink-0 text-right font-mono text-[9.5px] text-ink-faint">
                      ×{c.usedBy}
                    </span>
                  </Tooltip>
                </button>
              );
            })}
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
          <ComponentDetail key={componentId(selected)} component={selected} />
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

function ComponentDetail({ component: c }: { component: ComponentSurface }) {
  const { client } = useCrystal();
  const { report, systemOfFile } = useSurfaces();
  const arch = useArchHighlight();
  const nav = useNavUpdate();
  const [source, setSource] = useState<CodeSymbolSource | null>(null);
  const [sites, setSites] = useState<CodeSymbolSites | null>(null);
  const [snippetOpen, setSnippetOpen] = useState(false);

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

  const stories = (report?.stories ?? []).filter((s) => c.stories.includes(s.id));
  const screens = (report?.screens ?? []).filter((s) => c.screens.includes(s.id));

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

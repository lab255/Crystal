import { useMemo, useState } from "react";
import {
  BookOpenText,
  Component as ComponentIcon,
  Copy,
  Globe,
  MonitorPlay,
  MonitorX,
} from "lucide-react";
import { storybookStorySlug, type StorySurface } from "@crystal/core";
import { useNav, useNavUpdate, useSymbolMenu } from "@crystal/client";
import {
  EmptyState,
  Pane as SplitPane,
  Split,
  Tooltip,
  cn,
  useContextMenu,
} from "@crystal/ui";
import {
  DetailSection,
  DevServerPreview,
  FileLink,
  GroupHeader,
  LENS_DIM_CLASS,
  LensHint,
  ListHeader,
  copyText,
  storybookStoryUrl,
  useLiveDevUrls,
  useSurfaces,
  useSurfacesLens,
  type DevServerControl,
} from "./common.js";

/**
 * Stories — the workspace's CSF stories, grouped by their meta title, with a
 * live Storybook embed per story when Storybook is running
 * (`#/surfaces/stories?story=…&demo=1`).
 */

export function StoriesView() {
  const { report } = useSurfaces();
  const nav = useNavUpdate();
  const selectedId = useNav((l) => l.surfaces?.story ?? null);
  const demoOpen = useNav((l) => l.surfaces?.demo ?? false);
  const find = (useNav((l) => l.surfaces?.find) ?? "").trim().toLowerCase();
  const menu = useContextMenu();
  const symbolMenu = useSymbolMenu();
  const lens = useSurfacesLens();
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());

  const stories = report?.stories ?? [];
  const { storybook } = useLiveDevUrls();
  const storybookUrl =
    storybook.target?.availability === "live" ? storybook.target.url : null;

  /** Lens members (null when no lens dims) — non-members render dimmed. */
  const lensMembers = useMemo(
    () =>
      lens.active
        ? new Set(stories.filter((s) => lens.matcher.file(s.file)).map((s) => s.id))
        : null,
    [lens, stories],
  );

  const visible = useMemo(
    () =>
      stories.filter(
        (s) =>
          !find ||
          s.title.toLowerCase().includes(find) ||
          s.name.toLowerCase().includes(find) ||
          s.file.toLowerCase().includes(find),
      ),
    [stories, find],
  );

  const groups = useMemo(() => {
    const byTitle = new Map<string, StorySurface[]>();
    for (const s of visible) {
      const list = byTitle.get(s.title) ?? [];
      list.push(s);
      byTitle.set(s.title, list);
    }
    return [...byTitle.entries()]
      .map(([title, list]) => ({ title, list }))
      .sort((a, b) => a.title.localeCompare(b.title));
  }, [visible]);

  const selected = stories.find((s) => s.id === selectedId) ?? null;

  if (stories.length === 0) {
    return (
      <EmptyState icon={BookOpenText} title="No stories detected">
        CSF stories (`*.stories.tsx` with a default-export meta and named story exports) appear
        here, grouped by their meta title and linked to the component they exercise.
      </EmptyState>
    );
  }

  const rowMenu = (s: StorySurface): Parameters<typeof menu.open>[1] => [
    { type: "heading", label: `${s.title} / ${s.name}` },
    ...(s.componentFile && s.componentName
      ? [
          {
            type: "item" as const,
            label: "Show component",
            icon: ComponentIcon,
            hint: s.componentName,
            onSelect: () =>
              nav({
                surfaces: { view: "components", component: `${s.componentFile}#${s.componentName}` },
              }),
          },
        ]
      : []),
    ...(storybookUrl
      ? [
          {
            type: "item" as const,
            label: "Open live in Storybook pane",
            icon: MonitorPlay,
            onSelect: () => nav({ surfaces: { story: s.id, demo: true } }),
          },
          {
            type: "item" as const,
            label: "Open in browser",
            icon: Globe,
            onSelect: () =>
              window.open(
                `${storybookUrl}/?path=/story/${storybookStorySlug(s.title, s.name)}`,
                "_blank",
                "noopener",
              ),
          },
        ]
      : []),
    // Shared cross-view block for the story export (`id` is `${file}#${export}`).
    ...symbolMenu({
      file: s.file,
      line: s.line,
      symbol: s.id.split("#")[1],
      label: `${s.title} / ${s.name}`,
    }),
    {
      type: "item",
      label: "Copy story id",
      icon: Copy,
      hint: storybookStorySlug(s.title, s.name),
      onSelect: () => copyText(storybookStorySlug(s.title, s.name)),
    },
  ];

  return (
    <Split storageKey="surfaces:stories" direction="horizontal">
      <SplitPane defaultSize={320} minSize={240} maxSize={520}>
        <aside className="flex h-full flex-col border-r border-edge bg-surface-1">
          <ListHeader
            icon={BookOpenText}
            title="Stories"
            shown={visible.length}
            total={stories.length}
          >
            <LensHint lens={lens} matched={lensMembers?.size ?? 0} total={stories.length} />
          </ListHeader>
          <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
            {groups.map(({ title, list }) => (
              <div key={title} className="mb-1.5">
                <GroupHeader
                  label={title}
                  count={list.length}
                  collapsed={collapsed.has(title)}
                  onToggle={() =>
                    setCollapsed((c) => {
                      const next = new Set(c);
                      if (next.has(title)) next.delete(title);
                      else next.add(title);
                      return next;
                    })
                  }
                />
                {!collapsed.has(title)
                  ? list.map((s) => (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() => nav({ surfaces: { story: s.id } })}
                        onContextMenu={(e) => menu.open(e, rowMenu(s))}
                        className={cn(
                          "flex w-full items-center gap-1.5 rounded-lg px-2 py-1 text-left",
                          selected?.id === s.id
                            ? "bg-crystal-500/15 text-ink"
                            : "text-ink-muted hover:bg-surface-2 hover:text-ink",
                          lensMembers && !lensMembers.has(s.id) && LENS_DIM_CLASS,
                        )}
                      >
                        <span className="min-w-0 flex-1 truncate text-[11px]">{s.name}</span>
                        {s.componentName ? (
                          <span className="max-w-24 shrink-0 truncate text-[9.5px] text-ink-faint">
                            {s.componentName}
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
          <StoryDetail
            key={selected.id}
            story={selected}
            storybook={storybook}
            demoOpen={demoOpen}
            onToggleDemo={(open) => nav({ surfaces: { demo: open } })}
          />
        ) : (
          <EmptyState icon={BookOpenText} title="Pick a story">
            The story's source, its component, and a live Storybook render when Storybook is
            running.
          </EmptyState>
        )}
      </SplitPane>
      {menu.element}
    </Split>
  );
}

function StoryDetail({
  story,
  storybook,
  demoOpen,
  onToggleDemo,
}: {
  story: StorySurface;
  storybook: DevServerControl;
  demoOpen: boolean;
  onToggleDemo: (open: boolean) => void;
}) {
  const nav = useNavUpdate();
  const slug = storybookStorySlug(story.title, story.name);
  const live = storybook.target?.availability === "live";
  const storybookUrl = storybook.target?.url ?? null;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-surface-0">
      <div className="border-b border-edge bg-surface-1 px-4 py-3">
        <div className="flex items-center gap-2">
          <BookOpenText className="h-4 w-4 shrink-0 text-accent-amber" />
          <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-ink">
            <span className="text-ink-muted">{story.title} / </span>
            {story.name}
          </span>
          <Tooltip content="The Storybook story id">
            <span className="shrink-0 rounded bg-surface-3 px-1.5 py-0.5 font-mono text-[9.5px] text-ink-faint">
              {slug}
            </span>
          </Tooltip>
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px] text-ink-muted">
          {story.componentName && story.componentFile ? (
            <Tooltip content="Show in the components view">
              <button
                type="button"
                onClick={() =>
                  nav({
                    surfaces: {
                      view: "components",
                      component: `${story.componentFile}#${story.componentName}`,
                    },
                  })
                }
                className="flex items-center gap-1 rounded-md border border-edge bg-surface-2 px-1.5 py-0.5 hover:text-ink"
              >
                <ComponentIcon className="h-3 w-3 text-accent-violet" />
                {story.componentName}
              </button>
            </Tooltip>
          ) : null}
          <FileLink file={story.file} line={story.line} />
        </div>
      </div>

      <DetailSection
        title="Live render"
        hint={
          live
            ? `Storybook detected at ${storybookUrl}`
            : storybookUrl
              ? `expected at ${storybookUrl} — not responding`
              : "start Storybook to render this story here"
        }
        actions={
          live ? (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => window.open(`${storybookUrl}/?path=/story/${slug}`, "_blank", "noopener")}
                className="flex items-center gap-1 text-[10px] text-ink-faint hover:text-ink"
              >
                <Globe className="h-3 w-3" /> browser
              </button>
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
        <DevServerPreview
          control={storybook}
          url={storybookUrl ? storybookStoryUrl(storybookUrl, story.title, story.name) : null}
          title={`Storybook render of ${story.title}/${story.name}`}
          hint={`Render ${story.name} live`}
          open={demoOpen}
          onOpenChange={onToggleDemo}
          kind="storybook"
        />
      </DetailSection>

      <DetailSection title="Source" hint="where this story is declared">
        <div className="space-y-1 text-[11px] text-ink-muted">
          <div className="flex items-center gap-2">
            <span className="w-20 shrink-0 text-[10px] uppercase tracking-wider text-ink-faint">
              Story file
            </span>
            <FileLink file={story.file} line={story.line} />
          </div>
          {story.componentFile ? (
            <div className="flex items-center gap-2">
              <span className="w-20 shrink-0 text-[10px] uppercase tracking-wider text-ink-faint">
                Component
              </span>
              <FileLink file={story.componentFile} />
            </div>
          ) : null}
        </div>
      </DetailSection>
    </div>
  );
}

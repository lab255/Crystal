import { useMemo } from "react";
import {
  ArrowDownRight,
  ArrowUpRight,
  Component,
  Copy,
  FolderGit2,
  MoveRight,
  Package,
  PanelsTopLeft,
  Plug,
  Webhook,
} from "lucide-react";
import {
  formatHighlightSel,
  type SystemLink,
  type SystemModule,
} from "@crystal/core";
import { useNav, useNavUpdate, useSymbolMenu, useWorkspaces } from "@crystal/client";
import { Badge, Tooltip, cn, useContextMenu } from "@crystal/ui";
import { requestOpenFile } from "../codemap/CodeMapView.js";
import { ROLE_META } from "../systems/role-meta.js";

/**
 * System detail sections in the architecture inspector — the restored
 * `SystemDetail` pane of the retired systems view. Rendered when the selected
 * canvas node maps to an overview system: parts, internal wiring, intents,
 * the consumed export surface (with the shared symbol menu), components,
 * served routes, outbound API calls and the consumes/consumed-by boundaries.
 *
 * Panels speak RAW overview ids; the canvas translates to canonical node ids
 * for focusing and contract lookups.
 */

/** What the canvas resolves for a selected system node. */
export interface SystemSelection {
  system: SystemModule;
  /** All overview links (raw ids) — the pane filters in/outbound itself. */
  links: readonly SystemLink[];
  /** Display name of a raw overview system id. */
  nameOf: (rawId: string) => string;
}

function Section({ title, children }: { title: React.ReactNode; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
        {title}
      </div>
      {children}
    </div>
  );
}

export function SystemPanel({
  selection,
  onFocusSystem,
  onOpenBoundary,
  onStartJourney,
}: {
  selection: SystemSelection;
  /** Jump the canvas to another system (raw overview id). */
  onFocusSystem?: (rawId: string) => void;
  /** Open the contract inspector on a boundary link. */
  onOpenBoundary?: (link: SystemLink) => void;
  /** Seed a dataflow journey at a symbol (canvas capability). */
  onStartJourney?: (seed: { file: string; symbol: string }) => void;
}) {
  const { system, links, nameOf } = selection;
  const meta = ROLE_META[system.role];
  const RoleIcon = meta.icon;
  const outbound = useMemo(() => links.filter((l) => l.source === system.id), [links, system.id]);
  const inbound = useMemo(() => links.filter((l) => l.target === system.id), [links, system.id]);
  const apiOutbound = useMemo(
    () => outbound.filter((l) => (l.apis?.length ?? 0) > 0),
    [outbound],
  );
  // Right-click on parts/exports/components/endpoints: the shared symbol
  // menu — never hand-rolled pin/editor/code-map/coverage/copy entries.
  const menu = useContextMenu();
  const symbolMenu = useSymbolMenu();
  const nav = useNavUpdate();
  const ws = useWorkspaces((s) => s.activeId);
  // A highlight pinned from elsewhere (e.g. a surfaces component) marks its
  // row here — the surfaces→architecture side of the bidirectional link.
  const pinnedSel = useNav((l) => l.architect?.sel) ?? null;
  const isPinned = (file: string, symbol: string) =>
    pinnedSel != null && pinnedSel === formatHighlightSel({ file, symbol });

  // Clicking a boundary row inspects the contract in place; the explicit
  // arrow button is the only way the row leaves for the other system.
  const linkRow = (link: SystemLink, other: string, dir: "out" | "in") => (
    <div
      key={`${dir}:${other}`}
      className="group flex w-full items-start gap-1.5 rounded-md px-1.5 py-1 hover:bg-surface-active"
    >
      <Tooltip content="Inspect the boundary contract">
        <button
          type="button"
          onClick={() => onOpenBoundary?.(link)}
          className="flex min-w-0 flex-1 items-start gap-1.5 text-left"
        >
          {dir === "out" ? (
            <ArrowUpRight className="mt-0.5 h-3 w-3 shrink-0 text-ink-faint" />
          ) : (
            <ArrowDownRight className="mt-0.5 h-3 w-3 shrink-0 text-ink-faint" />
          )}
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[11px] text-ink">{nameOf(other)}</span>
            {link.symbols.length > 0 && (
              <span className="block truncate font-mono text-[9px] text-ink-faint">
                {link.symbols.join(", ")}
              </span>
            )}
          </span>
          <span className="shrink-0 text-[10px] text-ink-faint">×{link.weight}</span>
        </button>
      </Tooltip>
      <Tooltip content={`Go to ${nameOf(other)}`}>
        <button
          type="button"
          onClick={() => onFocusSystem?.(other)}
          aria-label={`Go to ${nameOf(other)}`}
          className="mt-0.5 shrink-0 rounded text-ink-faint opacity-0 hover:text-ink focus-visible:opacity-100 group-hover:opacity-100"
        >
          <MoveRight className="h-3 w-3" />
        </button>
      </Tooltip>
    </div>
  );

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-1.5 rounded-lg border border-edge bg-surface-1 px-2.5 py-1.5 text-[10.5px] text-ink-muted">
        <RoleIcon className="h-3.5 w-3.5 shrink-0" style={{ color: meta.accent }} />
        <span className="min-w-0 truncate">
          {meta.label} · {system.fileCount} files
          {system.concept ? ` · intent:${system.concept}` : ""}
        </span>
      </div>

      <Section title="Parts">
        {system.parts.map((p) => (
          <div
            key={p.path}
            onContextMenu={(evt) =>
              menu.open(evt, [
                { type: "heading", label: p.path },
                ...symbolMenu({ module: p.pkg, label: p.path.split("/").at(-1) ?? p.path }),
              ])
            }
            className="group flex items-center gap-1.5 rounded-md px-1.5 py-0.5 hover:bg-surface-active"
          >
            <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-ink-muted">
              {p.path}
            </span>
            <span className="shrink-0 text-[9px] text-ink-faint">{p.fileCount}</span>
            {ws ? (
              <Tooltip content="Show in the code map">
                <button
                  type="button"
                  onClick={() =>
                    nav({
                      architect: {
                        view: "codebase",
                        codemap: { kind: "module", ws, path: p.pkg },
                      },
                    })
                  }
                  aria-label={`Show ${p.path} in the code map`}
                  className="shrink-0 text-ink-faint opacity-0 hover:text-ink focus-visible:opacity-100 group-hover:opacity-100"
                >
                  <FolderGit2 className="h-3 w-3" />
                </button>
              </Tooltip>
            ) : null}
          </div>
        ))}
      </Section>

      {(system.partLinks?.length ?? 0) > 0 ? (
        <Section title="Internal wiring">
          {system.partLinks!.map((pl) => (
            <div
              key={`${pl.source}->${pl.target}`}
              className="flex items-center gap-1 px-1.5 py-0.5"
            >
              <span
                className="min-w-0 truncate font-mono text-[10px] text-ink-muted"
                title={pl.source}
              >
                {pl.source.split("/").at(-1)}
              </span>
              <ArrowUpRight className="h-3 w-3 shrink-0 text-ink-faint" />
              <span
                className="min-w-0 truncate font-mono text-[10px] text-ink-muted"
                title={pl.target}
              >
                {pl.target.split("/").at(-1)}
              </span>
              <span className="ml-auto shrink-0 text-[9px] text-ink-faint">×{pl.weight}</span>
            </div>
          ))}
        </Section>
      ) : null}

      {system.intents.length > 0 ? (
        <Section title="Intents">
          <div className="flex flex-wrap gap-1 px-1.5 py-0.5">
            {system.intents.map((i) => (
              <Badge key={i.value} tone="neutral">
                {i.value} <span className="ml-0.5 text-ink-faint">{i.weight}</span>
              </Badge>
            ))}
          </div>
        </Section>
      ) : null}

      <Section title={`Exports · ${system.exports.length} consumed of ${system.exportedTotal}`}>
        {system.exports.length === 0 ? (
          <div className="px-1.5 py-0.5 text-[10px] text-ink-faint">
            Nothing outside this system imports from it.
          </div>
        ) : null}
        {system.exports.map((e) => (
          <button
            key={`${e.file}#${e.name}`}
            type="button"
            onClick={() => requestOpenFile(e.file)}
            onContextMenu={(evt) =>
              menu.open(evt, [
                { type: "heading", label: e.name },
                ...symbolMenu(
                  { file: e.file, symbol: e.name, label: e.name },
                  { startJourney: onStartJourney },
                ),
              ])
            }
            className={cn(
              "w-full rounded-md px-1.5 py-0.5 text-left hover:bg-surface-active",
              isPinned(e.file, e.name) && "bg-crystal-500/15 ring-1 ring-crystal-500/40",
            )}
            title={e.file}
          >
            <span className="flex items-baseline gap-1.5">
              <span className="shrink-0 text-[9px] uppercase text-ink-faint">
                {e.kind.slice(0, 2)}
              </span>
              <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-ink">
                {e.name}
              </span>
              <span className="shrink-0 text-[9px] text-ink-faint">×{e.consumers}</span>
            </span>
            {e.signature ? (
              <span
                className="block truncate pl-4 font-mono text-[9px] text-ink-faint"
                title={e.signature}
              >
                {e.signature}
              </span>
            ) : null}
          </button>
        ))}
      </Section>

      {system.componentCount > 0 ? (
        <Section title={`Components · ${system.componentCount}`}>
          {system.components.map((c) => (
            <div
              key={`${c.file}#${c.name}`}
              onContextMenu={(evt) =>
                menu.open(evt, [
                  { type: "heading", label: c.name },
                  ...symbolMenu(
                    { file: c.file, symbol: c.name, label: c.name },
                    { startJourney: onStartJourney },
                  ),
                ])
              }
              className={cn(
                "group flex w-full items-center gap-1.5 rounded-md px-1.5 py-0.5 hover:bg-surface-active",
                isPinned(c.file, c.name) && "bg-crystal-500/15 ring-1 ring-crystal-500/40",
              )}
            >
              <button
                type="button"
                onClick={() => requestOpenFile(c.file)}
                title={c.file}
                className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
              >
                <Component className="h-3 w-3 shrink-0 text-accent-violet" />
                <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-ink">
                  {c.name}
                </span>
                {c.consumers > 0 ? (
                  <Tooltip
                    content={`${c.consumers} file${c.consumers === 1 ? "" : "s"} outside this system import it`}
                  >
                    <span className="shrink-0 text-[9px] text-ink-faint">×{c.consumers}</span>
                  </Tooltip>
                ) : null}
              </button>
              <Tooltip content="Open in the surfaces view — definition, usages and API calls">
                <button
                  type="button"
                  onClick={() =>
                    nav({
                      mode: "surfaces",
                      surfaces: { view: "components", component: `${c.file}#${c.name}` },
                    })
                  }
                  aria-label={`Open ${c.name} in the surfaces view`}
                  className="shrink-0 text-ink-faint opacity-0 hover:text-ink focus-visible:opacity-100 group-hover:opacity-100"
                >
                  <PanelsTopLeft className="h-3 w-3" />
                </button>
              </Tooltip>
            </div>
          ))}
          {system.componentCount > system.components.length ? (
            <div className="px-1.5 py-0.5 text-[10px] text-ink-faint">
              +{system.componentCount - system.components.length} more — open the code map for
              the full inventory
            </div>
          ) : null}
        </Section>
      ) : null}

      {system.endpoints.length > 0 ? (
        <Section
          title={`Serves · ${system.endpoints.length} route${system.endpoints.length === 1 ? "" : "s"}`}
        >
          {system.endpoints.map((ep) => (
            <div
              key={`${ep.method} ${ep.path}@${ep.file}`}
              onContextMenu={(evt) =>
                menu.open(evt, [
                  { type: "heading", label: `${ep.method} ${ep.path}` },
                  {
                    type: "item",
                    label: "Open in API explorer",
                    icon: Webhook,
                    onSelect: () =>
                      nav({
                        mode: "surfaces",
                        surfaces: { view: "apis", api: `${ep.method} ${ep.path}` },
                      }),
                  },
                  ...symbolMenu({
                    file: ep.file,
                    line: ep.line,
                    symbol: ep.handler,
                    label: `${ep.method} ${ep.path}`,
                  }),
                  {
                    type: "item",
                    label: "Copy route",
                    icon: Copy,
                    onSelect: () =>
                      void navigator.clipboard?.writeText(`${ep.method} ${ep.path}`),
                  },
                ])
              }
              className="group flex w-full items-center gap-1.5 rounded-md px-1.5 py-0.5 hover:bg-surface-active"
            >
              <button
                type="button"
                onClick={() => requestOpenFile(ep.file, ep.line)}
                title={ep.file}
                className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
              >
                <span className="shrink-0 rounded bg-accent-amber/15 px-1 font-mono text-[9px] font-semibold uppercase text-accent-amber">
                  {ep.method}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-ink">
                  {ep.path}
                </span>
              </button>
              <Tooltip content="Open in the API explorer — handler, trace and callers">
                <button
                  type="button"
                  onClick={() =>
                    nav({
                      mode: "surfaces",
                      surfaces: { view: "apis", api: `${ep.method} ${ep.path}` },
                    })
                  }
                  aria-label={`Open ${ep.method} ${ep.path} in the API explorer`}
                  className="shrink-0 text-ink-faint opacity-0 hover:text-ink focus-visible:opacity-100 group-hover:opacity-100"
                >
                  <Webhook className="h-3 w-3" />
                </button>
              </Tooltip>
            </div>
          ))}
        </Section>
      ) : null}

      {apiOutbound.length > 0 ? (
        <Section title="Calls APIs">
          {apiOutbound.flatMap((l) =>
            (l.apis ?? []).map((a) => (
              <div
                key={`${l.target}:${a.method} ${a.path}`}
                className="group flex w-full items-center gap-1.5 rounded-md px-1.5 py-0.5 hover:bg-surface-active"
              >
                <Tooltip content="Inspect the boundary contract">
                  <button
                    type="button"
                    onClick={() => onOpenBoundary?.(l)}
                    className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                  >
                    <span className="shrink-0 rounded bg-accent-amber/15 px-1 font-mono text-[9px] font-semibold uppercase text-accent-amber">
                      {a.method}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-ink">
                      {a.path}
                    </span>
                    <span className="max-w-24 shrink-0 truncate text-[9px] text-ink-faint">
                      {nameOf(l.target)}
                    </span>
                    <span className="shrink-0 text-[9px] text-ink-faint">×{a.weight}</span>
                  </button>
                </Tooltip>
                <Tooltip content="Open in the API explorer — handler, trace and callers">
                  <button
                    type="button"
                    onClick={() =>
                      nav({
                        mode: "surfaces",
                        surfaces: { view: "apis", api: `${a.method} ${a.path}` },
                      })
                    }
                    aria-label={`Open ${a.method} ${a.path} in the API explorer`}
                    className="shrink-0 text-ink-faint opacity-0 hover:text-ink focus-visible:opacity-100 group-hover:opacity-100"
                  >
                    <Webhook className="h-3 w-3" />
                  </button>
                </Tooltip>
              </div>
            )),
          )}
        </Section>
      ) : null}

      {outbound.length > 0 || system.externals.length > 0 || system.libraries.length > 0 ? (
        <Section title="Consumes">
          {outbound.map((l) => linkRow(l, l.target, "out"))}
          {system.externals.map((x) => (
            <div key={x.id} className="flex items-center gap-1.5 px-1.5 py-1">
              <Plug className="h-3 w-3 shrink-0 text-accent-amber" />
              <span className="min-w-0 flex-1 truncate text-[11px] text-ink">{x.name}</span>
              <span className="shrink-0 text-[10px] text-ink-faint">×{x.weight}</span>
            </div>
          ))}
          {system.libraries.map((l) => (
            <div key={l.pkg} className="flex items-center gap-1.5 px-1.5 py-1">
              <Package className="h-3 w-3 shrink-0 text-ink-faint" />
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-muted">
                {l.pkg}
              </span>
              <span className="shrink-0 text-[10px] text-ink-faint">×{l.weight}</span>
            </div>
          ))}
        </Section>
      ) : null}

      {inbound.length > 0 ? (
        <Section title="Consumed by">{inbound.map((l) => linkRow(l, l.source, "in"))}</Section>
      ) : null}
      {menu.element}
    </div>
  );
}

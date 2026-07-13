import { useMemo, useState } from "react";
import { Copy, Database, ExternalLink } from "lucide-react";
import type { SchemaKind, SchemaSurface } from "@crystal/core";
import { requestOpenFile, useNav, useNavUpdate } from "@crystal/client";
import { Badge, EmptyState, Pane as SplitPane, Split, Tooltip, cn, type BadgeTone } from "@crystal/ui";
import { DetailSection, FileLink, GroupHeader, ListHeader, copyText, useMenu, useSurfaces } from "./common.js";

/**
 * Schemas — the shapes data takes at the boundaries: zod objects, model
 * interfaces/types, mongoose schemas and prisma models, with their fields
 * inline (`#/surfaces/schemas?schema=…`).
 */

const KIND_LABEL: Record<SchemaKind, string> = {
  zod: "Zod",
  interface: "Interfaces",
  type: "Type aliases",
  mongoose: "Mongoose",
  prisma: "Prisma",
};

const KIND_TONE: Record<SchemaKind, BadgeTone> = {
  zod: "emerald",
  interface: "violet",
  type: "blue",
  mongoose: "amber",
  prisma: "cyan",
};

const KIND_ORDER: SchemaKind[] = ["zod", "prisma", "mongoose", "interface", "type"];

/** `{ name: string; age?: number }`-style text for the copy menu. */
function schemaAsText(s: SchemaSurface): string {
  const fields = s.fields
    .map((f) => `  ${f.name}${f.optional ? "?" : ""}${f.type ? `: ${f.type}` : ""};`)
    .join("\n");
  return `${s.name} {\n${fields}${s.fieldsTruncated ? "\n  // …truncated" : ""}\n}`;
}

export function SchemasView() {
  const { report } = useSurfaces();
  const nav = useNavUpdate();
  const selectedId = useNav((l) => l.surfaces?.schema ?? null);
  const find = (useNav((l) => l.surfaces?.find) ?? "").trim().toLowerCase();
  const menu = useMenu();
  const [collapsed, setCollapsed] = useState<ReadonlySet<SchemaKind>>(new Set());

  const schemas = report?.schemas ?? [];
  const visible = useMemo(
    () =>
      schemas.filter(
        (s) =>
          !find ||
          s.name.toLowerCase().includes(find) ||
          s.file.toLowerCase().includes(find) ||
          s.fields.some((f) => f.name.toLowerCase().includes(find)),
      ),
    [schemas, find],
  );

  const groups = useMemo(() => {
    const byKind = new Map<SchemaKind, SchemaSurface[]>();
    for (const s of visible) {
      const list = byKind.get(s.kind) ?? [];
      list.push(s);
      byKind.set(s.kind, list);
    }
    return KIND_ORDER.filter((k) => byKind.has(k)).map((k) => ({ kind: k, list: byKind.get(k)! }));
  }, [visible]);

  const selected = schemas.find((s) => s.id === selectedId) ?? null;

  if (schemas.length === 0) {
    return (
      <EmptyState icon={Database} title="No data schemas detected">
        Zod objects, mongoose schemas, prisma models — plus exported interfaces and type aliases
        from model/schema/dto-named files — appear here with their fields inline.
      </EmptyState>
    );
  }

  const rowMenu = (s: SchemaSurface): Parameters<typeof menu.open>[1] => [
    { type: "heading", label: s.name },
    {
      type: "item",
      label: "Open in editor",
      icon: ExternalLink,
      hint: `${s.file.split("/").at(-1)}:${s.line}`,
      onSelect: () => requestOpenFile(s.file, s.line),
    },
    { type: "separator" },
    {
      type: "item",
      label: "Copy name",
      icon: Copy,
      hint: s.name,
      onSelect: () => copyText(s.name),
    },
    {
      type: "item",
      label: "Copy fields",
      icon: Copy,
      hint: `${s.fields.length} fields`,
      onSelect: () => copyText(schemaAsText(s)),
    },
  ];

  return (
    <Split storageKey="surfaces:schemas" direction="horizontal">
      <SplitPane defaultSize={320} minSize={240} maxSize={520}>
        <aside className="flex h-full flex-col border-r border-edge bg-surface-1">
          <ListHeader icon={Database} title="Schemas" shown={visible.length} total={schemas.length} />
          <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
            {groups.map(({ kind, list }) => (
              <div key={kind} className="mb-1.5">
                <GroupHeader
                  label={KIND_LABEL[kind]}
                  count={list.length}
                  collapsed={collapsed.has(kind)}
                  onToggle={() =>
                    setCollapsed((c) => {
                      const next = new Set(c);
                      if (next.has(kind)) next.delete(kind);
                      else next.add(kind);
                      return next;
                    })
                  }
                />
                {!collapsed.has(kind)
                  ? list.map((s) => (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() => nav({ surfaces: { schema: s.id } })}
                        onContextMenu={(e) => menu.open(e, rowMenu(s))}
                        className={cn(
                          "flex w-full items-center gap-1.5 rounded-lg px-2 py-1 text-left",
                          selected?.id === s.id
                            ? "bg-crystal-500/15 text-ink"
                            : "text-ink-muted hover:bg-surface-2 hover:text-ink",
                        )}
                      >
                        <span className="min-w-0 flex-1 truncate text-[11px] font-medium">
                          {s.name}
                        </span>
                        <Tooltip content={`${s.fields.length} field${s.fields.length === 1 ? "" : "s"}`}>
                          <span className="shrink-0 font-mono text-[9.5px] text-ink-faint">
                            {s.fields.length}
                            {s.fieldsTruncated ? "+" : ""}
                          </span>
                        </Tooltip>
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
          <SchemaDetail key={selected.id} schema={selected} />
        ) : (
          <EmptyState icon={Database} title="Pick a schema">
            Its fields, their types, and where the shape is declared.
          </EmptyState>
        )}
      </SplitPane>
      {menu.element}
    </Split>
  );
}

function SchemaDetail({ schema: s }: { schema: SchemaSurface }) {
  const find = (useNav((l) => l.surfaces?.find) ?? "").trim().toLowerCase();
  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-surface-0">
      <div className="border-b border-edge bg-surface-1 px-4 py-3">
        <div className="flex items-center gap-2">
          <Database className="h-4 w-4 shrink-0 text-accent-emerald" />
          <span className="min-w-0 flex-1 truncate font-mono text-[13px] font-semibold text-ink">
            {s.name}
          </span>
          <Badge tone={KIND_TONE[s.kind]}>{s.kind}</Badge>
          {s.usedBy > 0 ? <Badge tone="neutral">×{s.usedBy} importers</Badge> : null}
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px] text-ink-muted">
          <FileLink file={s.file} line={s.line} />
        </div>
      </div>

      <DetailSection
        title={`Fields · ${s.fields.length}${s.fieldsTruncated ? "+" : ""}`}
        hint={s.fieldsTruncated ? "capped — open the source for the full shape" : undefined}
      >
        {s.fields.length === 0 ? (
          <div className="text-[11px] text-ink-faint">
            No fields captured — the shape may be computed or extend another type.
          </div>
        ) : (
          <table className="w-full border-separate border-spacing-0 text-left">
            <thead>
              <tr className="text-[9.5px] uppercase tracking-wider text-ink-faint">
                <th className="border-b border-edge px-1.5 pb-1 font-semibold">Field</th>
                <th className="border-b border-edge px-1.5 pb-1 font-semibold">Type</th>
                <th className="w-14 border-b border-edge px-1.5 pb-1 text-right font-semibold">
                  Required
                </th>
              </tr>
            </thead>
            <tbody>
              {s.fields.map((f) => {
                const hit = find && f.name.toLowerCase().includes(find);
                return (
                  <tr key={f.name} className={cn(hit && "bg-crystal-500/10")}>
                    <td className="border-b border-edge/40 px-1.5 py-1 font-mono text-[10.5px] text-ink">
                      {f.name}
                    </td>
                    <td className="max-w-0 truncate border-b border-edge/40 px-1.5 py-1 font-mono text-[10.5px] text-ink-muted">
                      {f.type ? (
                        <Tooltip content={f.type}>
                          <span>{f.type}</span>
                        </Tooltip>
                      ) : (
                        <span className="text-ink-faint">—</span>
                      )}
                    </td>
                    <td className="border-b border-edge/40 px-1.5 py-1 text-right text-[10px]">
                      {f.optional ? (
                        <span className="text-ink-faint">optional</span>
                      ) : (
                        <span className="text-ok">yes</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </DetailSection>
    </div>
  );
}

import { useMemo, useState } from "react";
import { Copy, Database, KeyRound, MoveRight, Network, Table2 } from "lucide-react";
import type { SchemaKind, SchemaSurface } from "@crystal/core";
import { SchemaDiagram } from "./SchemaDiagram.js";
import { useNav, useNavUpdate, useSymbolMenu } from "@crystal/client";
import {
  Badge,
  EmptyState,
  Pane as SplitPane,
  Split,
  Tooltip,
  cn,
  useContextMenu,
  type BadgeTone,
} from "@crystal/ui";
import {
  DetailSection,
  FileLink,
  GroupHeader,
  LENS_DIM_CLASS,
  LensHint,
  ListHeader,
  copyText,
  useSurfaces,
  useSurfacesLens,
} from "./common.js";

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
  drizzle: "Drizzle",
  typeorm: "TypeORM",
  sql: "SQL tables",
};

const KIND_TONE: Record<SchemaKind, BadgeTone> = {
  zod: "emerald",
  interface: "violet",
  type: "blue",
  mongoose: "amber",
  prisma: "cyan",
  drizzle: "emerald",
  typeorm: "rose",
  sql: "slate",
};

const KIND_ORDER: SchemaKind[] = [
  "prisma",
  "drizzle",
  "typeorm",
  "sql",
  "mongoose",
  "zod",
  "interface",
  "type",
];

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
  const menu = useContextMenu();
  const symbolMenu = useSymbolMenu();
  const lens = useSurfacesLens();
  const [collapsed, setCollapsed] = useState<ReadonlySet<SchemaKind>>(new Set());
  // "diagram" = the ER canvas over every visible schema; "fields" = the
  // selected schema's table. Diagram-clicks select in place; list-clicks
  // jump straight to the fields.
  const [tab, setTab] = useState<"diagram" | "fields">("diagram");

  const schemas = report?.schemas ?? [];
  /** Lens members (null when no lens dims) — non-members render dimmed. */
  const lensMembers = useMemo(
    () =>
      lens.active
        ? new Set(schemas.filter((s) => lens.matcher.file(s.file)).map((s) => s.id))
        : null,
    [lens, schemas],
  );
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
        Prisma models, drizzle tables, TypeORM entities, SQL CREATE TABLEs, mongoose schemas and
        zod objects — plus exported interfaces and type aliases from model/schema/dto-named
        files — appear here as an ER diagram with their fields inline.
      </EmptyState>
    );
  }

  const rowMenu = (s: SchemaSurface): Parameters<typeof menu.open>[1] => [
    { type: "heading", label: s.name },
    // The shared cross-view block: pin, editor, code map, coverage, copy.
    ...symbolMenu({ file: s.file, line: s.line, symbol: s.name, label: s.name }),
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
          <ListHeader icon={Database} title="Schemas" shown={visible.length} total={schemas.length}>
            <LensHint lens={lens} matched={lensMembers?.size ?? 0} total={schemas.length} />
          </ListHeader>
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
                        onClick={() => {
                          nav({ surfaces: { schema: s.id } });
                          setTab("fields");
                        }}
                        onContextMenu={(e) => menu.open(e, rowMenu(s))}
                        className={cn(
                          "flex w-full items-center gap-1.5 rounded-lg px-2 py-1 text-left",
                          selected?.id === s.id
                            ? "bg-crystal-500/15 text-ink"
                            : "text-ink-muted hover:bg-surface-2 hover:text-ink",
                          lensMembers && !lensMembers.has(s.id) && LENS_DIM_CLASS,
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
        <div className="flex h-full min-h-0 flex-col">
          <div className="flex shrink-0 items-center gap-1 border-b border-edge bg-surface-1 px-2 py-1">
            <TabChip
              icon={Network}
              label="ER diagram"
              active={tab === "diagram"}
              onClick={() => setTab("diagram")}
            />
            <TabChip
              icon={Table2}
              label="Fields"
              active={tab === "fields"}
              onClick={() => setTab("fields")}
            />
          </div>
          <div className="min-h-0 flex-1">
            {tab === "diagram" ? (
              <SchemaDiagram
                schemas={visible}
                selectedId={selected?.id ?? null}
                onSelect={(id) => nav({ surfaces: { schema: id } })}
              />
            ) : selected ? (
              <SchemaDetail key={selected.id} schema={selected} />
            ) : (
              <EmptyState icon={Database} title="Pick a schema">
                Its fields, their types, and where the shape is declared.
              </EmptyState>
            )}
          </div>
        </div>
      </SplitPane>
      {menu.element}
    </Split>
  );
}

function TabChip({
  icon: Icon,
  label,
  active,
  onClick,
}: {
  icon: typeof Network;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "flex h-6 items-center gap-1.5 rounded-md px-2 text-[11px]",
        active ? "bg-crystal-500/20 text-crystal-300" : "text-ink-muted hover:bg-surface-2 hover:text-ink",
      )}
    >
      <Icon className="h-3 w-3" />
      {label}
    </button>
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
                      <span className="flex items-center gap-1">
                        {f.pk ? (
                          <Tooltip content="Primary key">
                            <KeyRound className="h-2.5 w-2.5 shrink-0 text-accent-amber" />
                          </Tooltip>
                        ) : null}
                        {f.name}
                        {f.references ? (
                          <Tooltip content={`References ${f.references}`}>
                            <span className="flex items-center gap-0.5 text-[9px] text-crystal-300">
                              <MoveRight className="h-2.5 w-2.5" />
                              {f.references}
                            </span>
                          </Tooltip>
                        ) : null}
                      </span>
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

import { useEffect, useMemo, useState } from "react";
import { ArrowDownLeft, ArrowUpRight, FileCode2, FileText, Trash2, X } from "lucide-react";
import {
  ARCH_EDGE_KINDS,
  ARCH_LAYERS,
  ARCH_NODE_KINDS,
  DEFAULT_LAYER_OF_KIND,
  ancestorsOf,
  isContainerKind,
  matchHighlight,
  type ArchEdge,
  type ArchEdgeKind,
  type ArchLayer,
  type ArchNode,
  type ArchNodeKind,
  type ArchitectureGraph,
  type CodeModule,
  type CodeModuleDetail,
  type HighlightRef,
  type SystemLink,
} from "@crystal/core";
import { useWorkspace } from "@crystal/client";
import { Button, Field, Input, Select, TagInput, Textarea, cn } from "@crystal/ui";
import { deleteEdges, deleteNodes, updateEdge, updateNode } from "./graph-ops.js";
import { ACCENT_CSS, EDGE_KIND_STYLE, KIND_META, type AccentName } from "./model.js";
import { SystemPanel, type SystemSelection } from "./panels/SystemPanel.js";
import { highlightAttrs, hlClass, useViewHighlight } from "./use-highlight.js";

/**
 * What the side pane explains about the selected node beyond its own fields:
 * drawn diagram connections plus the linked module's code-level import and
 * export relationships (computed by the canvas, which owns the code map data).
 */
export interface NodeInsight {
  /** Linked code module path, when the node resolves to one. */
  module: string | null;
  /** Module detail when already fetched — file list, export counts. */
  detail: CodeModuleDetail | null;
  /** Outgoing drawn edges — what this component uses. */
  uses: { nodeId: string; label: string; kind: ArchEdgeKind }[];
  /** Incoming drawn edges — what uses this component. */
  usedBy: { nodeId: string; label: string; kind: ArchEdgeKind }[];
  /** Code-level: modules this one imports (weight = file-level imports). */
  imports: { module: string; weight: number; nodeId: string | null }[];
  /** Code-level: modules importing this one. */
  importedBy: { module: string; weight: number; nodeId: string | null }[];
}

const HOVER_OUT = "var(--color-accent-cyan)";
const HOVER_IN = "var(--color-accent-emerald)";

export function Inspector({
  graph,
  node,
  edge,
  codeModules,
  insight,
  systemSel,
  onFocusSystem,
  onOpenBoundary,
  onStartJourney,
  onFocusNode,
  onGraphChange,
  onOpenContract,
  onClearSelection,
}: {
  graph: ArchitectureGraph;
  node?: ArchNode;
  edge?: ArchEdge;
  /** Code-map modules of the active workspace, for linking nodes to code. */
  codeModules?: CodeModule[];
  /** Connections + code imports/exports of the selected node. */
  insight?: NodeInsight | null;
  /**
   * Overview facts when the selected node maps to a system — renders the
   * restored system detail sections in place of the generic code insight.
   */
  systemSel?: SystemSelection | null;
  /** Jump the canvas to another system (raw overview id). */
  onFocusSystem?: (rawId: string) => void;
  /** Open the contract inspector on a boundary link. */
  onOpenBoundary?: (link: SystemLink) => void;
  /** Seed a dataflow journey at a symbol. */
  onStartJourney?: (seed: { file: string; symbol: string }) => void;
  /** Jump the canvas to a related node. */
  onFocusNode?: (id: string) => void;
  onGraphChange: (graph: ArchitectureGraph) => void;
  /** Open a derived edge's boundary contract; false = no contract known. */
  onOpenContract?: (edgeId: string) => boolean;
  onClearSelection: () => void;
}) {
  return (
    <div className="absolute bottom-3 right-3 top-3 z-10 flex w-72 flex-col rounded-xl border border-edge bg-surface-2/95 shadow-2xl shadow-black/40 backdrop-blur">
      <div className="flex items-center justify-between border-b border-edge px-3 py-2">
        <span className="min-w-0 truncate text-xs font-semibold text-ink">
          {node ? `${node.label} — ${KIND_META[node.kind].label}` : "Connection"}
        </span>
        <Button variant="ghost" size="icon-sm" onClick={onClearSelection} aria-label="Close inspector">
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        {node ? (
          <>
            <AncestryBreadcrumb graph={graph} node={node} onFocusNode={onFocusNode} />
            {/* A system node leads with its restored detail sections (parts,
                exports, routes, boundaries) — the editable fields follow. */}
            {systemSel ? (
              <SystemPanel
                selection={systemSel}
                onFocusSystem={onFocusSystem}
                onOpenBoundary={onOpenBoundary}
                onStartJourney={onStartJourney}
              />
            ) : null}
            <NodeEditor
              node={node}
              graph={graph}
              codeModules={codeModules}
              onGraphChange={onGraphChange}
              onDeleted={onClearSelection}
            />
            {!systemSel && insight ? (
              <NodeInsightSections insight={insight} onFocusNode={onFocusNode} />
            ) : null}
          </>
        ) : edge ? (
          <EdgeEditor
            edge={edge}
            graph={graph}
            onGraphChange={onGraphChange}
            onOpenContract={onOpenContract}
            onDeleted={onClearSelection}
          />
        ) : null}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Containment chain of the selected node                              */
/* ------------------------------------------------------------------ */

function AncestryBreadcrumb({
  graph,
  node,
  onFocusNode,
}: {
  graph: ArchitectureGraph;
  node: ArchNode;
  onFocusNode?: (id: string) => void;
}) {
  const ancestors = useMemo(() => ancestorsOf(graph, node.id), [graph, node.id]);
  if (ancestors.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-1 gap-y-0.5 text-[10px]">
      {ancestors.map((a) => (
        <span key={a.id} className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => onFocusNode?.(a.id)}
            className="max-w-36 truncate text-ink-faint hover:text-ink-muted"
            title={`Show ${a.label} on canvas`}
          >
            {a.label}
          </button>
          <span className="text-ink-faint">›</span>
        </span>
      ))}
      <span className="max-w-36 truncate text-ink">{node.label}</span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Connections + code imports/exports of the selected node             */
/* ------------------------------------------------------------------ */

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
      {children}
    </div>
  );
}

function RelationRow({
  direction,
  label,
  hint,
  nodeId,
  onFocusNode,
  hlRef,
  hl,
  onHover,
}: {
  direction: "out" | "in";
  label: string;
  hint?: string;
  nodeId: string | null;
  onFocusNode?: (id: string) => void;
  /** Cross-view identity of this relation (see use-highlight.ts). */
  hlRef?: HighlightRef;
  /** Highlight classes when the row matches the external hover/pin. */
  hl?: string;
  /** Publish (`hlRef`) or clear (`null`) the inspector's hover. */
  onHover?: (ref: HighlightRef | null) => void;
}) {
  const color = direction === "out" ? HOVER_OUT : HOVER_IN;
  const Arrow = direction === "out" ? ArrowUpRight : ArrowDownLeft;
  const clickable = nodeId != null && onFocusNode != null;
  return (
    <button
      type="button"
      disabled={!clickable}
      onClick={() => clickable && onFocusNode(nodeId)}
      onMouseEnter={hlRef && onHover ? () => onHover(hlRef) : undefined}
      onMouseLeave={onHover ? () => onHover(null) : undefined}
      title={clickable ? "Show on canvas" : "Not on this diagram"}
      className={cn(
        "flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-[11px]",
        clickable ? "text-ink-muted hover:bg-surface-active hover:text-ink" : "cursor-default text-ink-muted",
        hl,
      )}
      {...(hlRef ? highlightAttrs(hlRef) : undefined)}
    >
      <Arrow className="h-3 w-3 shrink-0" style={{ color }} />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {hint ? <span className="shrink-0 font-mono text-[9.5px] text-ink-faint">{hint}</span> : null}
    </button>
  );
}

function NodeInsightSections({
  insight,
  onFocusNode,
}: {
  insight: NodeInsight;
  onFocusNode?: (id: string) => void;
}) {
  const { module, detail, uses, usedBy, imports, importedBy } = insight;
  const { hover, hoverSource, pinned, setHover } = useViewHighlight("inspector");
  // Hovers this panel published echo back through the store — skip them.
  const externalHover = hoverSource !== "inspector" ? hover : null;
  const hlFor = (el: HighlightRef) =>
    hlClass(matchHighlight(externalHover, el), matchHighlight(pinned, el));
  const totalExports = detail ? detail.files.reduce((s, f) => s + f.exportCount, 0) : null;
  const topExports = detail
    ? [...detail.files].sort((a, b) => b.exportCount - a.exportCount).filter((f) => f.exportCount > 0).slice(0, 3)
    : [];

  return (
    <>
      {uses.length > 0 || usedBy.length > 0 ? (
        <div>
          <SectionHeading>Connections</SectionHeading>
          {uses.map((u, i) => (
            <RelationRow
              key={`u${i}`}
              direction="out"
              label={u.label}
              hint={EDGE_KIND_STYLE[u.kind].label.toLowerCase()}
              nodeId={u.nodeId}
              onFocusNode={onFocusNode}
              hlRef={{ node: u.nodeId, label: u.label }}
              hl={hlFor({ node: u.nodeId })}
              onHover={setHover}
            />
          ))}
          {usedBy.map((u, i) => (
            <RelationRow
              key={`b${i}`}
              direction="in"
              label={u.label}
              hint={EDGE_KIND_STYLE[u.kind].label.toLowerCase()}
              nodeId={u.nodeId}
              onFocusNode={onFocusNode}
              hlRef={{ node: u.nodeId, label: u.label }}
              hl={hlFor({ node: u.nodeId })}
              onHover={setHover}
            />
          ))}
        </div>
      ) : null}

      {module ? (
        <div>
          <SectionHeading>Code — imports &amp; exports</SectionHeading>
          <div className="mb-1.5 rounded-lg border border-edge bg-surface-1 px-2 py-1.5 text-[10.5px] leading-snug text-ink-muted">
            <span className="font-mono text-ink">{module}</span>
            {detail ? (
              <>
                {" "}
                exports <span className="text-ink">{totalExports}</span> symbol
                {totalExports === 1 ? "" : "s"} from{" "}
                <span className="text-ink">{detail.files.length}</span> file
                {detail.files.length === 1 ? "" : "s"}.
              </>
            ) : null}{" "}
            {imports.length > 0 ? (
              <>
                Imports <span className="text-ink">{imports.length}</span> module
                {imports.length === 1 ? "" : "s"}
              </>
            ) : (
              "Imports nothing internal"
            )}
            {importedBy.length > 0 ? (
              <>
                {" "}
                · imported by <span className="text-ink">{importedBy.length}</span>.
              </>
            ) : (
              " · nothing imports it."
            )}
          </div>
          {imports.map((d) => (
            <RelationRow
              key={`i${d.module}`}
              direction="out"
              label={d.module}
              hint={`×${d.weight}`}
              nodeId={d.nodeId}
              onFocusNode={onFocusNode}
              hlRef={{ module: d.module }}
              hl={hlFor({ module: d.module })}
              onHover={setHover}
            />
          ))}
          {importedBy.map((d) => (
            <RelationRow
              key={`e${d.module}`}
              direction="in"
              label={d.module}
              hint={`×${d.weight}`}
              nodeId={d.nodeId}
              onFocusNode={onFocusNode}
              hlRef={{ module: d.module }}
              hl={hlFor({ module: d.module })}
              onHover={setHover}
            />
          ))}
          {topExports.length > 0 ? (
            <>
              <div className="mt-1.5 px-1.5 text-[9.5px] uppercase tracking-wider text-ink-faint">
                Main exports
              </div>
              {topExports.map((f) => (
                <div key={f.path} className="flex items-center gap-1.5 px-1.5 py-0.5 text-[11px] text-ink-muted">
                  <FileCode2 className="h-3 w-3 shrink-0 text-ink-faint" />
                  <span className="min-w-0 flex-1 truncate font-mono">{f.name}</span>
                  <span className="shrink-0 text-[9.5px] text-ink-faint">
                    {f.exportCount} export{f.exportCount === 1 ? "" : "s"}
                  </span>
                </div>
              ))}
            </>
          ) : null}
          <div className="mt-1 px-1.5 text-[9.5px] leading-snug text-ink-faint">
            <span style={{ color: HOVER_OUT }}>↗ uses / imports</span>
            {" · "}
            <span style={{ color: HOVER_IN }}>↙ used by / exports to</span>
            {" — hover the node to see these on the canvas."}
          </div>
        </div>
      ) : null}
    </>
  );
}

const EMPTY_REPOS: never[] = [];

function NodeEditor({
  node,
  graph,
  codeModules,
  onGraphChange,
  onDeleted,
}: {
  node: ArchNode;
  graph: ArchitectureGraph;
  codeModules?: CodeModule[];
  onGraphChange: (graph: ArchitectureGraph) => void;
  onDeleted: () => void;
}) {
  const repos = useWorkspace((s) => s.info?.manifest.repos ?? EMPTY_REPOS);
  const [label, setLabel] = useState(node.label);
  const [description, setDescription] = useState(node.description);

  useEffect(() => {
    setLabel(node.label);
    setDescription(node.description);
  }, [node.id]);

  const patch = (p: Partial<ArchNode>) => onGraphChange(updateNode(graph, node.id, p));

  // Container ⇄ leaf conversions would orphan children; keep switches within class.
  const kindOptions = ARCH_NODE_KINDS.filter(
    (k) => isContainerKind(k) === isContainerKind(node.kind),
  );

  return (
    <>
      <Field label="Name">
        <Input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onBlur={() => label.trim() && patch({ label: label.trim() })}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        />
      </Field>
      <Field label="Kind">
        <Select
          value={node.kind}
          onChange={(e) => patch({ kind: e.target.value as ArchNodeKind })}
          options={kindOptions.map((k) => ({ value: k, label: KIND_META[k].label }))}
        />
      </Field>
      <Field label="Description">
        <Textarea
          rows={3}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          onBlur={() => patch({ description })}
          placeholder="What does this do?"
        />
      </Field>
      {node.kind !== "note" ? (
        <Field label="Layer (top-down view)">
          <Select
            value={node.layer ?? ""}
            onChange={(e) => patch({ layer: (e.target.value || null) as ArchLayer | null })}
          >
            <option value="">
              Auto{DEFAULT_LAYER_OF_KIND[node.kind] ? ` (${DEFAULT_LAYER_OF_KIND[node.kind]})` : ""}
            </option>
            {ARCH_LAYERS.map((layer) => (
              <option key={layer} value={layer}>
                {layer}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}
      <Field label="Tech">
        {/* Pill adds/removes are discrete events, so each one commits straight
            to the graph — no local string state to resync on node switch. */}
        <TagInput
          value={node.tech}
          onChange={(tech) => patch({ tech })}
          placeholder="rust, postgres, ecs…"
          aria-label="Tech tags"
        />
      </Field>
      {codeModules && codeModules.length > 0 && node.kind !== "note" ? (
        <Field label="Code module">
          <Select
            value={node.codeModule ?? ""}
            onChange={(e) => patch({ codeModule: e.target.value || null })}
          >
            <option value="">None</option>
            {codeModules.map((m) => (
              <option key={m.path} value={m.path}>
                {m.name} {m.path !== "." ? `(${m.path})` : ""}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}
      {repos.length > 0 ? (
        <Field label="Linked repo">
          <Select
            value={node.repoId ?? ""}
            onChange={(e) => patch({ repoId: e.target.value || null })}
          >
            <option value="">None</option>
            {repos.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}
      <Field label="Accent">
        <div className="flex gap-1.5">
          {(Object.keys(ACCENT_CSS) as AccentName[]).map((accent) => (
            <button
              key={accent}
              type="button"
              aria-label={`Accent ${accent}`}
              onClick={() => patch({ accent })}
              className={cn(
                "h-5 w-5 rounded-full border-2 transition-transform hover:scale-110",
                (node.accent ?? KIND_META[node.kind].defaultAccent) === accent
                  ? "border-ink"
                  : "border-transparent",
              )}
              style={{ background: ACCENT_CSS[accent] }}
            />
          ))}
        </div>
      </Field>
      <Button
        variant="danger"
        size="sm"
        className="w-full justify-center"
        onClick={() => {
          onGraphChange(deleteNodes(graph, [node.id]));
          onDeleted();
        }}
      >
        <Trash2 className="h-3.5 w-3.5" />
        Delete {isContainerKind(node.kind) ? "container + contents" : "node"}
      </Button>
    </>
  );
}

function EdgeEditor({
  edge,
  graph,
  onGraphChange,
  onOpenContract,
  onDeleted,
}: {
  edge: ArchEdge;
  graph: ArchitectureGraph;
  onGraphChange: (graph: ArchitectureGraph) => void;
  onOpenContract?: (edgeId: string) => boolean;
  onDeleted: () => void;
}) {
  const [label, setLabel] = useState(edge.label);
  useEffect(() => setLabel(edge.label), [edge.id]);

  const nodeName = (id: string) => graph.nodes.find((n) => n.id === id)?.label ?? "?";
  const hasContract = onOpenContract != null && edge.id.startsWith("link:");

  return (
    <>
      <div className="rounded-lg border border-edge bg-surface-1 px-2.5 py-2 text-xs text-ink-muted">
        <span className="text-ink">{nodeName(edge.source)}</span>
        {" → "}
        <span className="text-ink">{nodeName(edge.target)}</span>
        {edge.apiOnly ? (
          <div className="mt-1 text-[10px] text-ink-faint">
            API-only boundary — talks over the wire, no imports cross.
          </div>
        ) : null}
        {edge.cycle ? (
          <div className="mt-1 text-[10px] text-warn">Part of a dependency cycle.</div>
        ) : null}
      </div>
      {hasContract ? (
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-center"
          onClick={() => onOpenContract(edge.id)}
        >
          <FileText className="h-3.5 w-3.5" />
          View boundary contract
        </Button>
      ) : null}
      <Field label="Kind">
        <Select
          value={edge.kind}
          onChange={(e) =>
            onGraphChange(updateEdge(graph, edge.id, { kind: e.target.value as ArchEdgeKind }))
          }
          options={ARCH_EDGE_KINDS.map((k) => ({ value: k, label: k }))}
        />
      </Field>
      <Field label="Label">
        <Input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onBlur={() => onGraphChange(updateEdge(graph, edge.id, { label }))}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          placeholder="e.g. gRPC, events"
        />
      </Field>
      <Button
        variant="danger"
        size="sm"
        className="w-full justify-center"
        onClick={() => {
          onGraphChange(deleteEdges(graph, [edge.id]));
          onDeleted();
        }}
      >
        <Trash2 className="h-3.5 w-3.5" />
        Delete connection
      </Button>
    </>
  );
}

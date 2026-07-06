import { useEffect, useState } from "react";
import { Trash2, X } from "lucide-react";
import {
  ARCH_EDGE_KINDS,
  ARCH_LAYERS,
  ARCH_NODE_KINDS,
  DEFAULT_LAYER_OF_KIND,
  isContainerKind,
  type ArchEdge,
  type ArchEdgeKind,
  type ArchLayer,
  type ArchNode,
  type ArchNodeKind,
  type ArchitectureGraph,
  type CodeModule,
} from "@crystal/core";
import { useWorkspace } from "@crystal/client";
import { Button, Input, Textarea, cn } from "@crystal/ui";
import { deleteEdges, deleteNodes, updateEdge, updateNode } from "./graph-ops.js";
import { ACCENT_CSS, KIND_META, type AccentName } from "./model.js";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
        {label}
      </div>
      {children}
    </label>
  );
}

const selectClasses =
  "w-full h-8 rounded-lg border border-edge bg-surface-1 px-2 text-[13px] text-ink " +
  "focus:border-crystal-500/60 focus:outline-none";

export function Inspector({
  graph,
  node,
  edge,
  codeModules,
  onGraphChange,
  onClearSelection,
}: {
  graph: ArchitectureGraph;
  node?: ArchNode;
  edge?: ArchEdge;
  /** Code-map modules of the active workspace, for linking nodes to code. */
  codeModules?: CodeModule[];
  onGraphChange: (graph: ArchitectureGraph) => void;
  onClearSelection: () => void;
}) {
  return (
    <div className="absolute right-3 top-3 z-10 w-64 rounded-xl border border-edge bg-surface-2/95 shadow-2xl shadow-black/40 backdrop-blur">
      <div className="flex items-center justify-between border-b border-edge px-3 py-2">
        <span className="text-xs font-semibold text-ink">
          {node ? KIND_META[node.kind].label : "Connection"}
        </span>
        <Button variant="ghost" size="icon-sm" onClick={onClearSelection} aria-label="Close inspector">
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div className="max-h-[60vh] space-y-3 overflow-y-auto p-3">
        {node ? (
          <NodeEditor
            node={node}
            graph={graph}
            codeModules={codeModules}
            onGraphChange={onGraphChange}
            onDeleted={onClearSelection}
          />
        ) : edge ? (
          <EdgeEditor edge={edge} graph={graph} onGraphChange={onGraphChange} onDeleted={onClearSelection} />
        ) : null}
      </div>
    </div>
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
  const [tech, setTech] = useState(node.tech.join(", "));

  useEffect(() => {
    setLabel(node.label);
    setDescription(node.description);
    setTech(node.tech.join(", "));
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
        <select
          className={selectClasses}
          value={node.kind}
          onChange={(e) => patch({ kind: e.target.value as ArchNodeKind })}
        >
          {kindOptions.map((k) => (
            <option key={k} value={k}>
              {KIND_META[k].label}
            </option>
          ))}
        </select>
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
          <select
            className={selectClasses}
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
          </select>
        </Field>
      ) : null}
      <Field label="Tech (comma-separated)">
        <Input
          value={tech}
          onChange={(e) => setTech(e.target.value)}
          onBlur={() =>
            patch({
              tech: tech
                .split(",")
                .map((t) => t.trim())
                .filter(Boolean),
            })
          }
          placeholder="rust, postgres, ecs"
        />
      </Field>
      {codeModules && codeModules.length > 0 && node.kind !== "note" ? (
        <Field label="Code module">
          <select
            className={selectClasses}
            value={node.codeModule ?? ""}
            onChange={(e) => patch({ codeModule: e.target.value || null })}
          >
            <option value="">None</option>
            {codeModules.map((m) => (
              <option key={m.path} value={m.path}>
                {m.name} {m.path !== "." ? `(${m.path})` : ""}
              </option>
            ))}
          </select>
        </Field>
      ) : null}
      {repos.length > 0 ? (
        <Field label="Linked repo">
          <select
            className={selectClasses}
            value={node.repoId ?? ""}
            onChange={(e) => patch({ repoId: e.target.value || null })}
          >
            <option value="">None</option>
            {repos.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
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
  onDeleted,
}: {
  edge: ArchEdge;
  graph: ArchitectureGraph;
  onGraphChange: (graph: ArchitectureGraph) => void;
  onDeleted: () => void;
}) {
  const [label, setLabel] = useState(edge.label);
  useEffect(() => setLabel(edge.label), [edge.id]);

  const nodeName = (id: string) => graph.nodes.find((n) => n.id === id)?.label ?? "?";

  return (
    <>
      <div className="rounded-lg border border-edge bg-surface-1 px-2.5 py-2 text-xs text-ink-muted">
        <span className="text-ink">{nodeName(edge.source)}</span>
        {" → "}
        <span className="text-ink">{nodeName(edge.target)}</span>
      </div>
      <Field label="Kind">
        <select
          className={selectClasses}
          value={edge.kind}
          onChange={(e) =>
            onGraphChange(updateEdge(graph, edge.id, { kind: e.target.value as ArchEdgeKind }))
          }
        >
          {ARCH_EDGE_KINDS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
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

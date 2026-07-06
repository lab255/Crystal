import { useEffect, useState } from "react";
import { Trash2, X } from "lucide-react";
import {
  ARCH_EDGE_KINDS,
  ARCH_LAYERS,
  ARCH_NODE_KINDS,
  DEFAULT_LAYER_OF_KIND,
  LB_ALGORITHMS,
  isContainerKind,
  type ArchEdge,
  type ArchEdgeKind,
  type ArchLayer,
  type ArchNode,
  type ArchNodeKind,
  type ArchitectureGraph,
  type CodeModule,
  type LbAlgorithm,
  type SimNodeConfig,
} from "@crystal/core";
import { useWorkspace } from "@crystal/client";
import { Button, Input, Switch, Textarea, cn } from "@crystal/ui";
import { deleteEdges, deleteNodes, updateEdge, updateNode } from "./graph-ops.js";
import { ACCENT_CSS, KIND_META, type AccentName } from "./model.js";
import { KIND_SIM_DEFAULTS, isSimKind } from "./simulation.js";

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
      {isSimKind(node.kind) ? <SimEditor node={node} onPatch={patch} /> : null}
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

const DEFAULT_BREAKER = { enabled: true, errorThreshold: 0.5, cooldownTicks: 6 };

/** Traffic-simulation knobs; every field falls back to the kind default. */
function SimEditor({
  node,
  onPatch,
}: {
  node: ArchNode;
  onPatch: (p: Partial<ArchNode>) => void;
}) {
  const defaults = KIND_SIM_DEFAULTS[node.kind];
  const sim = node.sim;
  const breaker = sim?.circuitBreaker;

  const patchSim = (p: Partial<SimNodeConfig>) =>
    onPatch({ sim: { replicas: 1, ...(sim ?? {}), ...p } });

  const numberField = (
    label: string,
    value: number | null | undefined,
    placeholder: number | undefined,
    onCommit: (v: number | null) => void,
    opts?: { min?: number; step?: number },
  ) => (
    <Field label={label}>
      <Input
        type="number"
        min={opts?.min ?? 1}
        step={opts?.step ?? 1}
        value={value ?? ""}
        placeholder={placeholder != null ? String(placeholder) : undefined}
        onChange={(e) => {
          const v = e.target.value === "" ? null : Number(e.target.value);
          if (v == null || Number.isFinite(v)) onCommit(v);
        }}
      />
    </Field>
  );

  return (
    <div className="space-y-3 border-t border-edge pt-3">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
        Simulation
      </div>
      <div className="grid grid-cols-2 gap-2">
        {numberField("Replicas", sim?.replicas === 1 ? null : sim?.replicas, 1, (v) =>
          patchSim({ replicas: Math.max(1, Math.round(v ?? 1)) }),
        )}
        {numberField("Capacity rps", sim?.capacityRps, defaults?.capacityRps, (v) =>
          patchSim({ capacityRps: v }),
        )}
      </div>
      {numberField("Base latency ms", sim?.latencyMs, defaults?.latencyMs, (v) =>
        patchSim({ latencyMs: v }), { min: 0 },
      )}
      {node.kind === "loadbalancer" || node.kind === "gateway" ? (
        <Field label="Balancing algorithm">
          <select
            className={selectClasses}
            value={sim?.lbAlgorithm ?? "round-robin"}
            onChange={(e) => patchSim({ lbAlgorithm: e.target.value as LbAlgorithm })}
          >
            {LB_ALGORITHMS.map((a) => (
              <option key={a} value={a}>
                {a === "round-robin"
                  ? "Round robin (no health checks)"
                  : a === "least-loaded"
                    ? "Least loaded (health aware)"
                    : "Weighted by capacity (health aware)"}
              </option>
            ))}
          </select>
        </Field>
      ) : null}
      {node.kind === "cache" ? (
        <Field label={`Hit rate — ${Math.round((sim?.cacheHitRate ?? defaults?.cacheHitRate ?? 0.85) * 100)}%`}>
          <input
            type="range"
            min={0}
            max={100}
            value={Math.round((sim?.cacheHitRate ?? defaults?.cacheHitRate ?? 0.85) * 100)}
            onChange={(e) => patchSim({ cacheHitRate: Number(e.target.value) / 100 })}
            className="h-1 w-full cursor-pointer"
            style={{ accentColor: "var(--color-crystal-400)" }}
          />
        </Field>
      ) : null}
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
          Circuit breaker
        </span>
        <Switch
          checked={breaker?.enabled ?? false}
          onChange={(enabled) =>
            patchSim({ circuitBreaker: { ...DEFAULT_BREAKER, ...(breaker ?? {}), enabled } })
          }
          aria-label="Circuit breaker"
        />
      </div>
      {breaker?.enabled ? (
        <div className="grid grid-cols-2 gap-2">
          <Field label={`Trip at ${Math.round(breaker.errorThreshold * 100)}% err`}>
            <input
              type="range"
              min={5}
              max={100}
              step={5}
              value={Math.round(breaker.errorThreshold * 100)}
              onChange={(e) =>
                patchSim({
                  circuitBreaker: { ...breaker, errorThreshold: Number(e.target.value) / 100 },
                })
              }
              className="h-1 w-full cursor-pointer"
              style={{ accentColor: "var(--color-crystal-400)" }}
            />
          </Field>
          <Field label="Cooldown ticks">
            <Input
              type="number"
              min={1}
              value={breaker.cooldownTicks}
              onChange={(e) => {
                const v = Math.max(1, Math.round(Number(e.target.value)));
                if (Number.isFinite(v))
                  patchSim({ circuitBreaker: { ...breaker, cooldownTicks: v } });
              }}
            />
          </Field>
        </div>
      ) : null}
    </div>
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

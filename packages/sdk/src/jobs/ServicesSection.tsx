import { useCallback, useEffect, useRef, useState } from "react";
import {
  BellRing,
  ChevronDown,
  ChevronRight,
  Play,
  Plus,
  RotateCw,
  ServerCog,
  Square,
  Trash2,
} from "lucide-react";
import {
  SERVICE_LOG_RING,
  WATCH_DEFAULT_MIN_INTERVAL_SEC,
  WATCH_PATTERN_MAX,
  createServiceDef,
  createWatchDef,
  type ServiceInfo,
  type ServiceLogChunk,
  type WatchInfo,
} from "@crystal/core";
import { useCrystal } from "@crystal/client";
import { Badge, Button, Input, Spinner, StatusDot, Tooltip, cn, type StatusKind } from "@crystal/ui";

/**
 * Managed services — supervised dev/setup/test commands (see core service.ts
 * and the server's ServiceManager). Definitions live in the repo
 * (`.crystal/services.json`); processes are server-owned, so they survive
 * closing this tab and restart with the server. Surfaces-mode previews point
 * at these ports.
 */
export function ServicesSection() {
  const { client } = useCrystal();
  const [services, setServices] = useState<ServiceInfo[] | null>(null);
  const [watches, setWatches] = useState<WatchInfo[]>([]);
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const result = await client.request("service.list", {});
    setServices(result.services);
    setWatches(result.watches);
  }, [client]);

  useEffect(() => {
    void refresh().catch(() => setServices([]));
    const disposeChanged = client.events.on("service.changed", ({ ws, service }) => {
      if (client.scope && ws !== client.scope) return;
      setServices((list) => {
        if (!list) return list;
        const idx = list.findIndex((s) => s.def.id === service.def.id);
        if (idx === -1) return [...list, service];
        const next = [...list];
        next[idx] = service;
        return next;
      });
    });
    const disposeFired = client.events.on("service.watchFired", ({ ws, watch }) => {
      if (client.scope && ws !== client.scope) return;
      setWatches((list) => list.map((w) => (w.def.id === watch.def.id ? watch : w)));
    });
    return () => {
      disposeChanged();
      disposeFired();
    };
  }, [client, refresh]);

  async function saveDefs(
    defs: ServiceInfo["def"][],
    watchDefs: WatchInfo["def"][] = watches.map((w) => w.def),
  ): Promise<void> {
    const result = await client.request("service.save", {
      services: { services: defs, watches: watchDefs },
    });
    setServices(result.services);
    setWatches(result.watches);
  }

  async function act(id: string, method: "service.start" | "service.stop" | "service.restart") {
    setNotice(null);
    try {
      await client.request(method, { serviceId: id });
    } catch (err) {
      setNotice((err as Error).message);
    }
  }

  return (
    <section className="rounded-xl border border-edge bg-surface-1 p-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="flex items-start gap-2.5">
          <span className="mt-0.5 text-ink-faint">
            <ServerCog className="h-4 w-4" />
          </span>
          <div>
            <h2 className="text-[13px] font-semibold text-ink">Services</h2>
            <p className="text-[11px] text-ink-faint">
              Dev servers and watchers supervised by Crystal — they outlive this tab, restart with
              the server, and feed the Surfaces live previews.
            </p>
          </div>
        </div>
        <Button variant="ghost" size="xs" onClick={() => setAdding((a) => !a)}>
          <Plus className="h-3.5 w-3.5" /> Add
        </Button>
      </div>

      {adding ? (
        <AddServiceForm
          onAdd={async (def) => {
            await saveDefs([...(services ?? []).map((s) => s.def), def]);
            setAdding(false);
          }}
          onCancel={() => setAdding(false)}
        />
      ) : null}

      {services === null ? (
        <Spinner className="h-3.5 w-3.5" />
      ) : services.length === 0 && !adding ? (
        <p className="text-[11px] text-ink-faint">
          No services yet — add your dev server (e.g. <code className="text-ink-muted">pnpm dev</code>)
          to start it from anywhere and keep it running.
        </p>
      ) : (
        <div className="flex flex-col gap-1">
          {services.map((service) => (
            <ServiceRow
              key={service.def.id}
              service={service}
              watches={watches.filter((w) => w.def.serviceId === service.def.id)}
              onStart={() => void act(service.def.id, "service.start")}
              onStop={() => void act(service.def.id, "service.stop")}
              onRestart={() => void act(service.def.id, "service.restart")}
              onDelete={() =>
                void saveDefs((services ?? []).map((s) => s.def).filter((d) => d.id !== service.def.id))
              }
              onSaveWatches={(next) =>
                void saveDefs(
                  (services ?? []).map((s) => s.def),
                  [...watches.map((w) => w.def).filter((d) => d.serviceId !== service.def.id), ...next],
                )
              }
            />
          ))}
        </div>
      )}
      {notice ? <p className="mt-2 text-[11px] text-warn">{notice}</p> : null}
    </section>
  );
}

function AddServiceForm({
  onAdd,
  onCancel,
}: {
  onAdd: (def: ReturnType<typeof createServiceDef>) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [cwd, setCwd] = useState(".");
  const [port, setPort] = useState("");
  const [saving, setSaving] = useState(false);
  // A port is optional; if given it must be a valid 1–65535 (the schema caps
  // it, so validate here rather than let createServiceDef throw on submit).
  const portNum = /^\d+$/.test(port.trim()) ? Number(port.trim()) : null;
  const portValid = port.trim() === "" || (portNum != null && portNum >= 1 && portNum <= 65535);
  const valid = Boolean(name.trim() && command.trim() && portValid);

  return (
    <form
      className="mb-3 grid grid-cols-[1fr_2fr] gap-2 rounded-lg border border-edge bg-surface-2 p-2.5"
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid) return;
        setSaving(true);
        void onAdd(
          createServiceDef({
            name: name.trim(),
            command: command.trim(),
            cwd: cwd.trim() || ".",
            port: portValid ? portNum : null,
          }),
        ).finally(() => setSaving(false));
      }}
    >
      <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Name (e.g. web dev server)" aria-label="Service name" />
      <Input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="Command (e.g. pnpm dev)" aria-label="Service command" className="font-mono" />
      <Input value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="Working dir (default .)" aria-label="Working directory" className="font-mono" />
      <div className="flex items-center gap-2">
        <Input
          value={port}
          onChange={(e) => setPort(e.target.value)}
          placeholder="Port (optional)"
          aria-label="Port"
          aria-invalid={!portValid}
          className={cn("w-32", !portValid && "border-danger/60")}
        />
        <span className="flex-1" />
        <Button type="button" variant="ghost" size="xs" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" size="xs" disabled={!valid || saving}>
          {saving ? <Spinner className="h-3 w-3" /> : <Plus className="h-3 w-3" />} Add service
        </Button>
      </div>
    </form>
  );
}

/** Service status → the shared StatusDot vocabulary + a label. */
const STATUS_TONES: Record<ServiceInfo["status"], { dot: StatusKind; label: string }> = {
  running: { dot: "running", label: "running" },
  starting: { dot: "queued", label: "starting" },
  stopped: { dot: "idle", label: "stopped" },
  exited: { dot: "idle", label: "exited" },
  failed: { dot: "failed", label: "crashed" },
};

function ServiceRow({
  service,
  watches,
  onStart,
  onStop,
  onRestart,
  onDelete,
  onSaveWatches,
}: {
  service: ServiceInfo;
  watches: WatchInfo[];
  onStart: () => void;
  onStop: () => void;
  onRestart: () => void;
  onDelete: () => void;
  onSaveWatches: (watchDefs: WatchInfo["def"][]) => void;
}) {
  const [logsOpen, setLogsOpen] = useState(false);
  const [watchOpen, setWatchOpen] = useState(false);
  const { def, status } = service;
  const live = status === "running" || status === "starting";
  const tone = STATUS_TONES[status];

  return (
    <div className="rounded-lg border border-edge bg-surface-2">
      <div className="flex items-center gap-2 px-2.5 py-1.5">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          onClick={() => setLogsOpen((o) => !o)}
          aria-expanded={logsOpen}
        >
          {logsOpen ? (
            <ChevronDown className="h-3 w-3 shrink-0 text-ink-faint" />
          ) : (
            <ChevronRight className="h-3 w-3 shrink-0 text-ink-faint" />
          )}
          <StatusDot status={tone.dot} />
          {/* The name is the identity — it never yields space to the command. */}
          <span className="shrink-0 text-[12px] font-medium text-ink">{def.name}</span>
          <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-ink-faint">
            {def.command}
          </span>
          {def.port != null ? <Badge tone="cyan">:{def.port}</Badge> : null}
          {watches.length > 0 ? (
            <Badge tone="amber">
              {watches.length} watch{watches.length > 1 ? "es" : ""}
            </Badge>
          ) : null}
          <span className="text-[10px] text-ink-faint">{tone.label}</span>
        </button>
        <Tooltip content="Watches: wake an agent when the log matches or the service crashes">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Watches for ${def.name}`}
            aria-expanded={watchOpen}
            onClick={() => setWatchOpen((o) => !o)}
          >
            <BellRing className={cn("h-3 w-3", watches.length > 0 ? "text-warn" : "")} />
          </Button>
        </Tooltip>
        {live ? (
          <>
            <Tooltip content="Restart">
              <Button variant="ghost" size="icon-sm" aria-label={`Restart ${def.name}`} onClick={onRestart}>
                <RotateCw className="h-3 w-3" />
              </Button>
            </Tooltip>
            <Tooltip content="Stop (kills the whole process tree)">
              <Button variant="ghost" size="icon-sm" aria-label={`Stop ${def.name}`} onClick={onStop}>
                <Square className="h-3 w-3 text-danger" />
              </Button>
            </Tooltip>
          </>
        ) : (
          <>
            <Tooltip content="Start">
              <Button variant="ghost" size="icon-sm" aria-label={`Start ${def.name}`} onClick={onStart}>
                <Play className="h-3 w-3 text-ok" />
              </Button>
            </Tooltip>
            <Tooltip content="Remove from the list">
              <Button variant="ghost" size="icon-sm" aria-label={`Delete ${def.name}`} onClick={onDelete}>
                <Trash2 className="h-3 w-3 text-danger" />
              </Button>
            </Tooltip>
          </>
        )}
      </div>
      {service.lastError && !live ? (
        <div className="border-t border-edge px-2.5 py-1.5 text-[11px] text-danger/90">
          {service.lastError}
        </div>
      ) : null}
      {watchOpen ? (
        <WatchPanel serviceId={def.id} watches={watches} onSave={onSaveWatches} />
      ) : null}
      {logsOpen ? <ServiceLogs serviceId={def.id} /> : null}
    </div>
  );
}

/** Per-service watch list + add form. */
function WatchPanel({
  serviceId,
  watches,
  onSave,
}: {
  serviceId: string;
  watches: WatchInfo[];
  onSave: (watchDefs: WatchInfo["def"][]) => void;
}) {
  const [pattern, setPattern] = useState("");
  const [instructions, setInstructions] = useState("");
  const defs = watches.map((w) => w.def);

  return (
    <div className="space-y-1.5 border-t border-edge px-2.5 py-2">
      {watches.map((watch) => (
        <div key={watch.def.id} className="flex items-center gap-2 text-[11px]">
          <button
            type="button"
            title={watch.def.enabled ? "Disable this watch" : "Enable this watch"}
            onClick={() =>
              onSave(defs.map((d) => (d.id === watch.def.id ? { ...d, enabled: !d.enabled } : d)))
            }
            className={cn(
              "rounded-full border px-1.5 text-[9px] uppercase tracking-wide",
              watch.def.enabled ? "border-warn/40 text-warn" : "border-edge text-ink-faint",
            )}
          >
            {watch.def.enabled ? "on" : "off"}
          </button>
          <span className="font-mono text-ink-muted">
            {watch.def.pattern || "(crash only)"}
          </span>
          <span className="min-w-0 flex-1 truncate text-ink-faint">{watch.def.instructions}</span>
          {watch.fireCount > 0 ? (
            <span className="text-[10px] text-ink-faint">fired ×{watch.fireCount}</span>
          ) : null}
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Delete watch"
            onClick={() => onSave(defs.filter((d) => d.id !== watch.def.id))}
          >
            <Trash2 className="h-3 w-3 text-danger" />
          </Button>
        </div>
      ))}
      <form
        className="flex items-center gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          if (!instructions.trim()) return;
          onSave([
            ...defs,
            createWatchDef({ serviceId, pattern: pattern.trim(), instructions: instructions.trim() }),
          ]);
          setPattern("");
          setInstructions("");
        }}
      >
        <Input
          value={pattern}
          onChange={(e) => setPattern(e.target.value)}
          placeholder="Log pattern, e.g. ERROR|^FATAL (blank = crash only)"
          aria-label="Watch pattern"
          // The schema caps the pattern; bound the input so createWatchDef
          // can't throw on submit.
          maxLength={WATCH_PATTERN_MAX}
          className="w-56 font-mono text-[11px]"
        />
        <Input
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          placeholder="What the woken agent should do"
          aria-label="Watch instructions"
          className="flex-1 text-[11px]"
        />
        <Button type="submit" variant="ghost" size="xs" disabled={!instructions.trim()}>
          <Plus className="h-3 w-3" /> Watch
        </Button>
      </form>
      <p className="text-[10px] text-ink-faint">
        Patterns are literal alternatives (never regex); a fired watch wakes one agent at a
        time, throttled to one fire per {Math.round(WATCH_DEFAULT_MIN_INTERVAL_SEC / 60)} minutes.
      </p>
    </div>
  );
}

/** Ring replay + live tail of one service's log. */
function ServiceLogs({ serviceId }: { serviceId: string }) {
  const { client } = useCrystal();
  const [lines, setLines] = useState<ServiceLogChunk[] | null>(null);
  const scrollRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    let disposed = false;
    void client.request("service.logs", { serviceId }).then(({ chunks }) => {
      if (!disposed) setLines(chunks);
    });
    const dispose = client.events.on("service.log", ({ ws, chunk }) => {
      if (client.scope && ws !== client.scope) return;
      if (chunk.serviceId !== serviceId) return;
      setLines((prev) => {
        if (!prev) return prev;
        // Seqs are monotonic per service — O(1) dedup against the tail.
        const last = prev[prev.length - 1];
        if (last && last.seq >= chunk.seq) return prev;
        const next = [...prev, chunk];
        return next.length > SERVICE_LOG_RING ? next.slice(-SERVICE_LOG_RING) : next;
      });
    });
    return () => {
      disposed = true;
      dispose();
    };
  }, [client, serviceId]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines?.length]);

  return (
    <pre
      ref={scrollRef}
      className="max-h-48 overflow-auto border-t border-edge px-2.5 py-1.5 font-mono text-[10.5px] leading-relaxed text-ink-muted"
    >
      {lines === null ? "…" : lines.length === 0 ? "(no output yet)" : lines.map((c) => c.text).join("\n")}
    </pre>
  );
}

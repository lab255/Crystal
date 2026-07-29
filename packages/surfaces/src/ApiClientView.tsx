import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Eye,
  EyeOff,
  Globe2,
  Play,
  Plus,
  Send,
  Settings2,
  Trash2,
  Webhook,
} from "lucide-react";
import {
  createApiRequestDef,
  resolveRequestUrl,
  resolveTemplate,
  type ApiClientState,
  type ApiEnvConfig,
  type ApiHttpResponse,
  type ApiRequestDef,
  type ArchEnvironment,
} from "@crystal/core";
import { useCrystal, useNav, useNavUpdate, useWorkspace } from "@crystal/client";
import {
  Badge,
  Button,
  EmptyState,
  Field,
  Input,
  Pane as SplitPane,
  Select,
  Split,
  Textarea,
  Tooltip,
  cn,
} from "@crystal/ui";
import { MethodChip } from "./ApiExplorer.js";
import { ListHeader, useSurfaces } from "./common.js";

/**
 * The API client — a Postman-shaped workbench over the workspace's own APIs
 * (`#/surfaces/client?request=…`). Requests persist server-side in app data
 * (never the repo — env configs carry secrets); execution goes through
 * `apiclient.send` on the bridge, so localhost targets work from any origin.
 * Environments are the infra view's `ArchEnvironment`s — this view only owns
 * each one's request-time half (base URL + variables).
 */

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
const SAVE_DEBOUNCE_MS = 700;

const EMPTY_ENVS: ArchEnvironment[] = [];
const EMPTY_CFG: ApiEnvConfig = { baseUrl: null, variables: [] };

export function ApiClientView() {
  const { client } = useCrystal();
  const nav = useNavUpdate();
  const selectedId = useNav((l) => l.surfaces?.request ?? null);
  const { report } = useSurfaces();

  // Environments come from the architecture overlay (the infra view owns the
  // list); this store holds per-env baseUrl/variables keyed by env id.
  const overlay = useWorkspace((s) => s.archOverlay);
  const loadArchOverlay = useWorkspace((s) => s.loadArchOverlay);
  useEffect(() => void loadArchOverlay(), [loadArchOverlay]);
  const environments = overlay?.environments ?? EMPTY_ENVS;

  const [state, setState] = useState<ApiClientState | null>(null);
  const [envPanelOpen, setEnvPanelOpen] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    client
      .request("apiclient.get", {})
      .then(({ state }) => {
        if (!cancelled) setState(state);
      })
      .catch(() => {
        if (!cancelled) setState({ requests: [], envConfigs: {}, activeEnvId: null });
      });
    return () => {
      cancelled = true;
    };
  }, [client]);

  /** Mutate + debounce-persist. Whole-state saves keep the seam simple. */
  const update = useCallback(
    (fn: (prev: ApiClientState) => ApiClientState) => {
      setState((prev) => {
        if (!prev) return prev;
        const next = fn(prev);
        if (saveTimer.current) clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(() => {
          void client.request("apiclient.save", { state: next }).catch(() => {});
        }, SAVE_DEBOUNCE_MS);
        return next;
      });
    },
    [client],
  );
  // Flush the pending save on unmount — switching subviews must not eat edits.
  useEffect(
    () => () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      setState((prev) => {
        if (prev) void client.request("apiclient.save", { state: prev }).catch(() => {});
        return prev;
      });
    },
    [client],
  );

  const activeEnvId =
    state?.activeEnvId && environments.some((e) => e.id === state.activeEnvId)
      ? state.activeEnvId
      : (environments[0]?.id ?? null);
  const activeCfg = (activeEnvId ? state?.envConfigs[activeEnvId] : null) ?? EMPTY_CFG;

  const selected = state?.requests.find((r) => r.id === selectedId) ?? null;

  const addRequest = useCallback(
    (over: Partial<ApiRequestDef> = {}) => {
      const req = createApiRequestDef(over);
      update((prev) => ({ ...prev, requests: [...prev.requests, req] }));
      nav({ surfaces: { request: req.id } });
    },
    [update, nav],
  );

  if (!state) return null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Environment bar — the unified env selector every request resolves against. */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 gap-y-1 border-b border-edge bg-surface-1 px-3 py-1.5">
        <Globe2 className="h-3.5 w-3.5 text-ink-faint" />
        <Select
          size="sm"
          value={activeEnvId ?? ""}
          onChange={(e) => update((p) => ({ ...p, activeEnvId: e.target.value || null }))}
          options={environments.map((env) => ({ value: env.id, label: env.name }))}
          aria-label="Active environment"
        />
        <span className="max-w-64 truncate font-mono text-[10px] text-ink-faint">
          {activeCfg.baseUrl ?? "no base URL"}
        </span>
        <button
          type="button"
          onClick={() => setEnvPanelOpen((o) => !o)}
          aria-pressed={envPanelOpen}
          className={cn(
            "flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px]",
            envPanelOpen ? "bg-crystal-500/20 text-crystal-300" : "text-ink-muted hover:text-ink",
          )}
        >
          <Settings2 className="h-3 w-3" />
          variables{activeCfg.variables.length > 0 ? ` (${activeCfg.variables.length})` : ""}
        </button>
        <span className="ml-auto text-[10px] text-ink-faint">
          environments are managed in the infra view — this holds each one's base URL + variables
        </span>
      </div>
      {envPanelOpen && activeEnvId ? (
        <EnvConfigPanel
          cfg={activeCfg}
          onChange={(cfg) =>
            update((p) => ({ ...p, envConfigs: { ...p.envConfigs, [activeEnvId]: cfg } }))
          }
        />
      ) : null}

      <Split storageKey="surfaces:apiclient" direction="horizontal" className="min-h-0 flex-1">
        <SplitPane defaultSize={300} minSize={220} maxSize={480}>
          <aside className="flex h-full flex-col border-r border-edge bg-surface-1">
            <ListHeader
              icon={Send}
              title="Requests"
              shown={state.requests.length}
              total={state.requests.length}
            >
              <Tooltip content="New request">
                <button
                  type="button"
                  onClick={() => addRequest()}
                  aria-label="New request"
                  className="rounded p-1 text-ink-faint hover:bg-surface-3 hover:text-ink"
                >
                  <Plus className="h-3.5 w-3.5" />
                </button>
              </Tooltip>
            </ListHeader>
            <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
              {state.requests.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => nav({ surfaces: { request: r.id } })}
                  className={cn(
                    "flex w-full items-center gap-1.5 rounded-lg px-2 py-1 text-left",
                    selected?.id === r.id
                      ? "bg-crystal-500/15 text-ink"
                      : "text-ink-muted hover:bg-surface-2 hover:text-ink",
                  )}
                >
                  <MethodChip method={r.method} />
                  <span className="min-w-0 flex-1 truncate text-[11px]">{r.name}</span>
                </button>
              ))}
              {state.requests.length === 0 ? (
                <div className="px-3 py-4 text-center text-[11px] text-ink-faint">
                  No saved requests yet.
                </div>
              ) : null}

              {(report?.endpoints.length ?? 0) > 0 ? (
                <div className="mt-3 border-t border-edge pt-2">
                  <div className="px-2 pb-1 text-[10px] font-medium uppercase tracking-wide text-ink-faint">
                    Detected endpoints
                  </div>
                  {report!.endpoints.slice(0, 100).map((ep) => (
                    <button
                      key={`${ep.method} ${ep.path}`}
                      type="button"
                      title={`Add ${ep.method} ${ep.path} as a request`}
                      onClick={() =>
                        addRequest({
                          name: `${ep.method} ${ep.path}`,
                          method: ep.method === "ALL" ? "GET" : ep.method,
                          url: ep.path,
                        })
                      }
                      className="group flex w-full items-center gap-1.5 rounded-lg px-2 py-0.5 text-left text-ink-faint hover:bg-surface-2 hover:text-ink"
                    >
                      <MethodChip method={ep.method} />
                      <span className="min-w-0 flex-1 truncate font-mono text-[10px]">
                        {ep.path}
                      </span>
                      <Plus className="h-3 w-3 shrink-0 opacity-0 group-hover:opacity-100" />
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          </aside>
        </SplitPane>
        <SplitPane minSize="40%">
          {selected ? (
            <RequestEditor
              key={selected.id}
              request={selected}
              cfg={activeCfg}
              onChange={(patch) =>
                update((p) => ({
                  ...p,
                  requests: p.requests.map((r) => (r.id === selected.id ? { ...r, ...patch } : r)),
                }))
              }
              onDelete={() => {
                update((p) => ({
                  ...p,
                  requests: p.requests.filter((r) => r.id !== selected.id),
                }));
                nav({ surfaces: { request: null } });
              }}
            />
          ) : (
            <EmptyState icon={Webhook} title="Pick or create a request">
              Saved requests run against the active environment — {"{{var}}"} templates and bare
              paths resolve from its variables and base URL. Detected endpoints add with one
              click.
            </EmptyState>
          )}
        </SplitPane>
      </Split>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Environment config                                                   */
/* ------------------------------------------------------------------ */

function EnvConfigPanel({
  cfg,
  onChange,
}: {
  cfg: ApiEnvConfig;
  onChange: (cfg: ApiEnvConfig) => void;
}) {
  return (
    <div className="shrink-0 space-y-2 border-b border-edge bg-surface-1/60 px-3 py-2">
      <Field label="Base URL" hint="Bare request paths resolve against this">
        <Input
          value={cfg.baseUrl ?? ""}
          onChange={(e) => onChange({ ...cfg, baseUrl: e.target.value || null })}
          placeholder="http://localhost:3000"
          className="h-7 max-w-96 font-mono text-xs"
        />
      </Field>
      <div>
        <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-ink-faint">
          Variables — reference as {"{{key}}"} in URLs, headers and bodies
        </div>
        {cfg.variables.map((v, i) => (
          <VariableRow
            key={i}
            variable={v}
            onChange={(nv) =>
              onChange({ ...cfg, variables: cfg.variables.map((x, j) => (j === i ? nv : x)) })
            }
            onDelete={() =>
              onChange({ ...cfg, variables: cfg.variables.filter((_, j) => j !== i) })
            }
          />
        ))}
        <Button
          variant="ghost"
          size="sm"
          onClick={() =>
            onChange({ ...cfg, variables: [...cfg.variables, { key: "", value: "" }] })
          }
        >
          <Plus className="h-3 w-3" /> Add variable
        </Button>
      </div>
    </div>
  );
}

function VariableRow({
  variable: v,
  onChange,
  onDelete,
}: {
  variable: ApiEnvConfig["variables"][number];
  onChange: (v: ApiEnvConfig["variables"][number]) => void;
  onDelete: () => void;
}) {
  const [reveal, setReveal] = useState(false);
  const masked = Boolean(v.secret) && !reveal;
  return (
    <div className="mb-1 flex items-center gap-1.5">
      <Input
        value={v.key}
        onChange={(e) => onChange({ ...v, key: e.target.value.trim() })}
        placeholder="key"
        aria-label="Variable name"
        className="h-6 w-40 font-mono text-[11px]"
      />
      <Input
        type={masked ? "password" : "text"}
        value={v.value}
        onChange={(e) => onChange({ ...v, value: e.target.value })}
        placeholder="value"
        aria-label="Variable value"
        className="h-6 max-w-80 flex-1 font-mono text-[11px]"
      />
      <Tooltip content={v.secret ? "Secret — stored in app data, masked here" : "Mark as secret"}>
        <button
          type="button"
          aria-pressed={Boolean(v.secret)}
          onClick={() => {
            if (v.secret) setReveal((r) => !r);
            else onChange({ ...v, secret: true });
          }}
          className={cn(
            "rounded p-1",
            v.secret ? "text-warn" : "text-ink-faint hover:text-ink",
          )}
        >
          {masked ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
        </button>
      </Tooltip>
      <button
        type="button"
        onClick={onDelete}
        aria-label="Delete variable"
        className="rounded p-1 text-ink-faint hover:text-danger"
      >
        <Trash2 className="h-3 w-3" />
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Request editor + response                                            */
/* ------------------------------------------------------------------ */

function RequestEditor({
  request,
  cfg,
  onChange,
  onDelete,
}: {
  request: ApiRequestDef;
  cfg: ApiEnvConfig;
  onChange: (patch: Partial<ApiRequestDef>) => void;
  onDelete: () => void;
}) {
  const { client } = useCrystal();
  const [response, setResponse] = useState<ApiHttpResponse | null>(null);
  const [sending, setSending] = useState(false);

  const finalUrl = useMemo(() => resolveRequestUrl(request.url, cfg), [request.url, cfg]);

  const send = useCallback(async () => {
    setSending(true);
    setResponse(null);
    try {
      const res = await client.request("apiclient.send", {
        method: request.method,
        url: finalUrl,
        headers: request.headers
          .filter((h) => h.key.trim())
          .map((h) => ({ key: h.key, value: resolveTemplate(h.value, cfg) })),
        body: request.body != null ? resolveTemplate(request.body, cfg) : null,
      });
      setResponse(res);
    } catch (err) {
      setResponse({
        status: 0,
        statusText: "",
        headers: [],
        body: "",
        durationMs: 0,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSending(false);
    }
  }, [client, request, finalUrl, cfg]);

  const hasBody = request.method !== "GET" && request.method !== "HEAD";

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-surface-0 p-3">
      <div className="flex items-center gap-2">
        <Input
          value={request.name}
          onChange={(e) => onChange({ name: e.target.value })}
          aria-label="Request name"
          className="h-7 max-w-72 text-xs font-medium"
        />
        <button
          type="button"
          onClick={onDelete}
          aria-label="Delete request"
          className="ml-auto rounded p-1 text-ink-faint hover:text-danger"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>

      <form
        className="mt-2 flex items-center gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <Select
          size="sm"
          value={request.method}
          onChange={(e) => onChange({ method: e.target.value })}
          options={METHODS.map((m) => ({ value: m, label: m }))}
          aria-label="Method"
          className="w-24 font-mono"
        />
        <Input
          value={request.url}
          onChange={(e) => onChange({ url: e.target.value })}
          placeholder="/api/things or https://… ({{var}} templates ok)"
          aria-label="Request URL"
          className="h-8 flex-1 font-mono text-xs"
        />
        <Button type="submit" size="sm" disabled={sending || !request.url.trim()}>
          {sending ? "Sending…" : (
            <>
              <Play className="h-3 w-3" /> Send
            </>
          )}
        </Button>
      </form>
      {finalUrl !== request.url.trim() ? (
        <div className="mt-1 truncate font-mono text-[10px] text-ink-faint" title={finalUrl}>
          → {finalUrl}
        </div>
      ) : null}

      <div className="mt-3">
        <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-ink-faint">
          Headers
        </div>
        {request.headers.map((h, i) => (
          <div key={i} className="mb-1 flex items-center gap-1.5">
            <Input
              value={h.key}
              onChange={(e) =>
                onChange({
                  headers: request.headers.map((x, j) =>
                    j === i ? { ...x, key: e.target.value } : x,
                  ),
                })
              }
              placeholder="Header"
              aria-label="Header name"
              className="h-6 w-52 font-mono text-[11px]"
            />
            <Input
              value={h.value}
              onChange={(e) =>
                onChange({
                  headers: request.headers.map((x, j) =>
                    j === i ? { ...x, value: e.target.value } : x,
                  ),
                })
              }
              placeholder="value ({{var}} ok)"
              aria-label="Header value"
              className="h-6 flex-1 font-mono text-[11px]"
            />
            <button
              type="button"
              onClick={() => onChange({ headers: request.headers.filter((_, j) => j !== i) })}
              aria-label="Delete header"
              className="rounded p-1 text-ink-faint hover:text-danger"
            >
              <Trash2 className="h-3 w-3" />
            </button>
          </div>
        ))}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onChange({ headers: [...request.headers, { key: "", value: "" }] })}
        >
          <Plus className="h-3 w-3" /> Add header
        </Button>
      </div>

      {hasBody ? (
        <div className="mt-3">
          <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-ink-faint">
            Body
          </div>
          <Textarea
            rows={6}
            value={request.body ?? ""}
            onChange={(e) => onChange({ body: e.target.value || null })}
            placeholder={'{ "raw": "JSON or text — {{var}} templates resolve" }'}
            className="font-mono text-[11px]"
          />
        </div>
      ) : null}

      {response ? <ResponsePanel response={response} /> : null}
    </div>
  );
}

function ResponsePanel({ response: r }: { response: ApiHttpResponse }) {
  const pretty = useMemo(() => {
    try {
      return JSON.stringify(JSON.parse(r.body), null, 2);
    } catch {
      return null;
    }
  }, [r.body]);
  const statusTone =
    r.status === 0
      ? "rose"
      : r.status < 300
        ? "emerald"
        : r.status < 400
          ? "amber"
          : "rose";
  return (
    <div className="mt-4 border-t border-edge pt-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={statusTone}>
          {r.status === 0 ? "failed" : `${r.status} ${r.statusText}`.trim()}
        </Badge>
        <span className="text-[10px] text-ink-faint">{r.durationMs} ms</span>
        {r.body ? (
          <span className="text-[10px] text-ink-faint">
            {r.body.length.toLocaleString()} chars{r.bodyTruncated ? " (truncated)" : ""}
          </span>
        ) : null}
      </div>
      {r.error ? (
        <div className="mt-2 rounded-md border border-danger/30 bg-danger/10 px-2 py-1.5 text-[11px] text-danger">
          {r.error}
        </div>
      ) : null}
      {r.headers.length > 0 ? (
        <details className="mt-2">
          <summary className="cursor-pointer text-[10px] font-medium uppercase tracking-wide text-ink-faint">
            Response headers ({r.headers.length})
          </summary>
          <div className="mt-1 space-y-0.5">
            {r.headers.map((h) => (
              <div key={h.key} className="flex gap-2 font-mono text-[10px]">
                <span className="shrink-0 text-ink-muted">{h.key}:</span>
                <span className="min-w-0 break-all text-ink-faint">{h.value}</span>
              </div>
            ))}
          </div>
        </details>
      ) : null}
      {r.body ? (
        <pre className="mt-2 max-h-96 overflow-auto rounded-lg border border-edge bg-surface-1 p-2 font-mono text-[10.5px] leading-relaxed text-ink-muted">
          {pretty ?? r.body}
        </pre>
      ) : null}
    </div>
  );
}

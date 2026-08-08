import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Eye, EyeOff, Play, Plus, Save, Trash2 } from "lucide-react";
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
import { useCrystal, useWorkspace, useWorkspaces } from "@crystal/client";
import { Badge, Button, Field, Input, Select, Textarea, Tooltip, cn } from "@crystal/ui";

/**
 * Shared request-running machinery for the API surface. State persists in
 * server-side app data (env configs may carry secrets), while sends stay on
 * the bridge so localhost targets work from any browser origin.
 */

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
const SAVE_DEBOUNCE_MS = 700;
const EMPTY_ENVS: ArchEnvironment[] = [];
const EMPTY_CFG: ApiEnvConfig = { baseUrl: null, variables: [] };

export interface ApiClientController {
  state: ApiClientState | null;
  environments: ArchEnvironment[];
  activeEnvId: string | null;
  activeCfg: ApiEnvConfig;
  addRequest: (over?: Partial<ApiRequestDef>) => ApiRequestDef | null;
  updateRequest: (id: string, patch: Partial<ApiRequestDef>) => void;
  deleteRequest: (id: string) => void;
  setActiveEnvId: (id: string | null) => void;
  setActiveCfg: (cfg: ApiEnvConfig) => void;
}

export function useApiClient(): ApiClientController {
  const { client } = useCrystal();
  const activeWs = useWorkspaces((s) => s.activeId);
  const overlay = useWorkspace((s) => s.archOverlay);
  const loadArchOverlay = useWorkspace((s) => s.loadArchOverlay);
  useEffect(() => void loadArchOverlay(), [loadArchOverlay]);
  const environments = overlay?.environments ?? EMPTY_ENVS;

  const [state, setState] = useState<ApiClientState | null>(null);
  const latestState = useRef<ApiClientState | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    latestState.current = null;
    setState(null);
    client
      .request("apiclient.get", activeWs ? { ws: activeWs } : {})
      .then(({ state: loaded }) => {
        if (cancelled) return;
        latestState.current = loaded;
        setState(loaded);
      })
      .catch(() => {
        if (cancelled) return;
        const empty = { requests: [], envConfigs: {}, activeEnvId: null };
        latestState.current = empty;
        setState(empty);
      });
    return () => {
      cancelled = true;
    };
  }, [activeWs, client]);

  const update = useCallback(
    (fn: (prev: ApiClientState) => ApiClientState) => {
      setState((prev) => {
        if (!prev) return prev;
        const next = fn(prev);
        latestState.current = next;
        if (saveTimer.current) clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(() => {
          saveTimer.current = null;
          void client
            .request("apiclient.save", {
              state: next,
              ...(activeWs ? { ws: activeWs } : {}),
            })
            .catch(() => {});
        }, SAVE_DEBOUNCE_MS);
        return next;
      });
    },
    [activeWs, client],
  );

  // Flush a pending edit when the API surface unmounts.
  useEffect(
    () => () => {
      if (!saveTimer.current) return;
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
      const latest = latestState.current;
      if (latest)
        void client
          .request("apiclient.save", {
            state: latest,
            ...(activeWs ? { ws: activeWs } : {}),
          })
          .catch(() => {});
    },
    [activeWs, client],
  );

  const activeEnvId =
    state?.activeEnvId && environments.some((env) => env.id === state.activeEnvId)
      ? state.activeEnvId
      : (environments[0]?.id ?? null);
  const activeCfg = (activeEnvId ? state?.envConfigs[activeEnvId] : null) ?? EMPTY_CFG;

  const addRequest = useCallback(
    (over: Partial<ApiRequestDef> = {}): ApiRequestDef | null => {
      if (!latestState.current) return null;
      const request = createApiRequestDef(over);
      update((prev) => ({ ...prev, requests: [...prev.requests, request] }));
      return request;
    },
    [update],
  );
  const updateRequest = useCallback(
    (id: string, patch: Partial<ApiRequestDef>) =>
      update((prev) => ({
        ...prev,
        requests: prev.requests.map((request) =>
          request.id === id ? { ...request, ...patch } : request,
        ),
      })),
    [update],
  );
  const deleteRequest = useCallback(
    (id: string) =>
      update((prev) => ({
        ...prev,
        requests: prev.requests.filter((request) => request.id !== id),
      })),
    [update],
  );
  const setActiveEnvId = useCallback(
    (id: string | null) => update((prev) => ({ ...prev, activeEnvId: id })),
    [update],
  );
  const setActiveCfg = useCallback(
    (cfg: ApiEnvConfig) => {
      if (!activeEnvId) return;
      update((prev) => ({
        ...prev,
        envConfigs: { ...prev.envConfigs, [activeEnvId]: cfg },
      }));
    },
    [activeEnvId, update],
  );

  return {
    state,
    environments,
    activeEnvId,
    activeCfg,
    addRequest,
    updateRequest,
    deleteRequest,
    setActiveEnvId,
    setActiveCfg,
  };
}

export function EnvConfigPanel({
  cfg,
  onChange,
  className,
}: {
  cfg: ApiEnvConfig;
  onChange: (cfg: ApiEnvConfig) => void;
  className?: string;
}) {
  return (
    <div className={cn("shrink-0 space-y-2 border-b border-edge bg-surface-1/60 px-3 py-2", className)}>
      <Field label="Base URL" hint="Bare request paths resolve against this">
        <Input
          value={cfg.baseUrl ?? ""}
          onChange={(e) => onChange({ ...cfg, baseUrl: e.target.value || null })}
          placeholder="http://localhost:3000"
          className="h-7 w-full font-mono text-xs"
        />
      </Field>
      <div>
        <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-ink-faint">
          Variables — use {"{{key}}"} in URLs, headers and bodies
        </div>
        {cfg.variables.map((variable, index) => (
          <VariableRow
            key={index}
            variable={variable}
            onChange={(next) =>
              onChange({
                ...cfg,
                variables: cfg.variables.map((entry, i) => (i === index ? next : entry)),
              })
            }
            onDelete={() =>
              onChange({
                ...cfg,
                variables: cfg.variables.filter((_, i) => i !== index),
              })
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
  variable,
  onChange,
  onDelete,
}: {
  variable: ApiEnvConfig["variables"][number];
  onChange: (variable: ApiEnvConfig["variables"][number]) => void;
  onDelete: () => void;
}) {
  const [reveal, setReveal] = useState(false);
  const masked = Boolean(variable.secret) && !reveal;
  return (
    <div className="mb-1 flex items-center gap-1.5">
      <Input
        value={variable.key}
        onChange={(e) => onChange({ ...variable, key: e.target.value.trim() })}
        placeholder="key"
        aria-label="Variable name"
        className="h-6 min-w-0 flex-[2] font-mono text-[11px]"
      />
      <Input
        type={masked ? "password" : "text"}
        value={variable.value}
        onChange={(e) => onChange({ ...variable, value: e.target.value })}
        placeholder="value"
        aria-label="Variable value"
        className="h-6 min-w-0 flex-[3] font-mono text-[11px]"
      />
      <Tooltip
        content={variable.secret ? "Secret — stored in app data, masked here" : "Mark as secret"}
      >
        <button
          type="button"
          aria-pressed={Boolean(variable.secret)}
          onClick={() => {
            if (variable.secret) setReveal((value) => !value);
            else onChange({ ...variable, secret: true });
          }}
          className={cn(
            "rounded p-1",
            variable.secret ? "text-warn" : "text-ink-faint hover:text-ink",
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

export function RequestEditor({
  request,
  cfg,
  onChange,
  onDelete,
  onSave,
  embedded = false,
}: {
  request: ApiRequestDef;
  cfg: ApiEnvConfig;
  onChange: (patch: Partial<ApiRequestDef>) => void;
  onDelete?: () => void;
  onSave?: () => void;
  embedded?: boolean;
}) {
  const { client } = useCrystal();
  const [response, setResponse] = useState<ApiHttpResponse | null>(null);
  const [sending, setSending] = useState(false);
  const finalUrl = useMemo(() => resolveRequestUrl(request.url, cfg), [request.url, cfg]);

  const send = useCallback(async () => {
    setSending(true);
    setResponse(null);
    try {
      const result = await client.request("apiclient.send", {
        method: request.method,
        url: finalUrl,
        headers: request.headers
          .filter((header) => header.key.trim())
          .map((header) => ({
            key: header.key,
            value: resolveTemplate(header.value, cfg),
          })),
        body: request.body != null ? resolveTemplate(request.body, cfg) : null,
      });
      setResponse(result);
    } catch (error) {
      setResponse({
        status: 0,
        statusText: "",
        headers: [],
        body: "",
        durationMs: 0,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setSending(false);
    }
  }, [cfg, client, finalUrl, request]);

  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  return (
    <div
      className={cn(
        "bg-surface-0",
        embedded ? "" : "flex h-full min-h-0 flex-col overflow-y-auto p-3",
      )}
    >
      <div className="flex items-center gap-2">
        <Input
          value={request.name}
          onChange={(e) => onChange({ name: e.target.value })}
          aria-label="Request name"
          className="h-7 max-w-72 text-xs font-medium"
        />
        <span className="ml-auto flex items-center gap-1">
          {onSave ? (
            <Button type="button" variant="secondary" size="sm" onClick={onSave}>
              <Save className="h-3 w-3" /> Save
            </Button>
          ) : null}
          {onDelete ? (
            <button
              type="button"
              onClick={onDelete}
              aria-label="Delete request"
              className="rounded p-1 text-ink-faint hover:text-danger"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </span>
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
          options={METHODS.map((method) => ({ value: method, label: method }))}
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
          {sending ? (
            "Sending…"
          ) : (
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
        {request.headers.map((header, index) => (
          <div key={index} className="mb-1 flex items-center gap-1.5">
            <Input
              value={header.key}
              onChange={(e) =>
                onChange({
                  headers: request.headers.map((entry, i) =>
                    i === index ? { ...entry, key: e.target.value } : entry,
                  ),
                })
              }
              placeholder="Header"
              aria-label="Header name"
              className="h-6 w-52 font-mono text-[11px]"
            />
            <Input
              value={header.value}
              onChange={(e) =>
                onChange({
                  headers: request.headers.map((entry, i) =>
                    i === index ? { ...entry, value: e.target.value } : entry,
                  ),
                })
              }
              placeholder="value ({{var}} ok)"
              aria-label="Header value"
              className="h-6 flex-1 font-mono text-[11px]"
            />
            <button
              type="button"
              onClick={() =>
                onChange({ headers: request.headers.filter((_, i) => i !== index) })
              }
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

export function ResponsePanel({ response }: { response: ApiHttpResponse }) {
  const pretty = useMemo(() => {
    try {
      return JSON.stringify(JSON.parse(response.body), null, 2);
    } catch {
      return null;
    }
  }, [response.body]);
  const statusTone =
    response.status === 0
      ? "rose"
      : response.status < 300
        ? "emerald"
        : response.status < 400
          ? "amber"
          : "rose";
  return (
    <div className="mt-4 border-t border-edge pt-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={statusTone}>
          {response.status === 0
            ? "failed"
            : `${response.status} ${response.statusText}`.trim()}
        </Badge>
        <span className="text-[10px] text-ink-faint">{response.durationMs} ms</span>
        {response.body ? (
          <span className="text-[10px] text-ink-faint">
            {response.body.length.toLocaleString()} chars
            {response.bodyTruncated ? " (truncated)" : ""}
          </span>
        ) : null}
      </div>
      {response.error ? (
        <div className="mt-2 rounded-md border border-danger/30 bg-danger/10 px-2 py-1.5 text-[11px] text-danger">
          {response.error}
        </div>
      ) : null}
      {response.headers.length > 0 ? (
        <details className="mt-2">
          <summary className="cursor-pointer text-[10px] font-medium uppercase tracking-wide text-ink-faint">
            Response headers ({response.headers.length})
          </summary>
          <div className="mt-1 space-y-0.5">
            {response.headers.map((header) => (
              <div key={header.key} className="flex gap-2 font-mono text-[10px]">
                <span className="shrink-0 text-ink-muted">{header.key}:</span>
                <span className="min-w-0 break-all text-ink-faint">{header.value}</span>
              </div>
            ))}
          </div>
        </details>
      ) : null}
      {response.body ? (
        <pre className="mt-2 max-h-96 overflow-auto rounded-lg border border-edge bg-surface-1 p-2 font-mono text-[10.5px] leading-relaxed text-ink-muted">
          {pretty ?? response.body}
        </pre>
      ) : null}
    </div>
  );
}

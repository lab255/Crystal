import { z } from "zod";
import { uid } from "./ids.js";

/**
 * API client — the Postman-shaped request workbench over the workspace's own
 * detected endpoints. Pure model + template rules here; persistence is
 * server-side app data (apps/server/src/api-client-store.ts — variables and
 * secrets must never land in the repo's `.crystal/`), execution is the
 * `apiclient.send` bridge method (the server holds the fetch — a browser tab
 * can't reach localhost APIs cross-origin).
 *
 * Environments are UNIFIED with the infra diagram: the environment LIST is
 * `ArchEnvironment`s from the architecture overlay (created/renamed/removed
 * in the infra view), and this store holds each environment's request-time
 * half — base URL + variables — keyed by `ArchEnvironment.id` (`envConfigs`).
 */

export const ApiVariableSchema = z.object({
  key: z.string(),
  value: z.string(),
  /** Masked in the UI. Stored in app data (never the repo) either way. */
  secret: z.boolean().optional(),
});
export type ApiVariable = z.infer<typeof ApiVariableSchema>;

export const ApiEnvConfigSchema = z.object({
  /** Base URL relative request paths resolve against ("http://localhost:3000"). */
  baseUrl: z.string().nullable().default(null),
  variables: z.array(ApiVariableSchema).default([]),
});
export type ApiEnvConfig = z.infer<typeof ApiEnvConfigSchema>;

export const ApiHeaderSchema = z.object({ key: z.string(), value: z.string() });
export type ApiHeader = z.infer<typeof ApiHeaderSchema>;

export const ApiRequestDefSchema = z.object({
  id: z.string(),
  name: z.string(),
  method: z.string().default("GET"),
  /** May carry `{{var}}` templates; a bare path resolves against the env baseUrl. */
  url: z.string().default(""),
  headers: z.array(ApiHeaderSchema).default([]),
  body: z.string().nullable().default(null),
});
export type ApiRequestDef = z.infer<typeof ApiRequestDefSchema>;

export const ApiClientStateSchema = z.object({
  requests: z.array(ApiRequestDefSchema).default([]),
  /** Per infra-environment request config, keyed by ArchEnvironment.id. */
  envConfigs: z.record(z.string(), ApiEnvConfigSchema).default({}),
  activeEnvId: z.string().nullable().default(null),
});
export type ApiClientState = z.infer<typeof ApiClientStateSchema>;

/** What `apiclient.send` returns — the response, or the transport failure. */
export interface ApiHttpResponse {
  /** 0 when the request never got a response (DNS, refused, timeout). */
  status: number;
  statusText: string;
  headers: ApiHeader[];
  body: string;
  bodyTruncated?: boolean;
  durationMs: number;
  /** Transport-level failure message (status 0). */
  error?: string;
}

export function createApiClientState(): ApiClientState {
  return ApiClientStateSchema.parse({});
}

export function createApiRequestDef(over: Partial<ApiRequestDef> = {}): ApiRequestDef {
  return ApiRequestDefSchema.parse({
    id: uid("req"),
    name: over.name ?? "New request",
    ...over,
  });
}

const TEMPLATE_RE = /\{\{\s*([\w.-]+)\s*\}\}/g;

/**
 * Substitute `{{var}}` templates from an environment config (plus the
 * implicit `{{baseUrl}}`). Unknown variables are left verbatim — visible in
 * the sent request rather than silently blanked.
 */
export function resolveTemplate(text: string, cfg: ApiEnvConfig | null | undefined): string {
  if (!cfg) return text;
  const byKey = new Map(cfg.variables.map((v) => [v.key, v.value]));
  if (cfg.baseUrl && !byKey.has("baseUrl")) byKey.set("baseUrl", cfg.baseUrl);
  return text.replace(TEMPLATE_RE, (whole, key: string) => byKey.get(key) ?? whole);
}

/**
 * A request's final URL: templates substituted, then bare paths joined onto
 * the environment's base URL. Absolute URLs pass through untouched.
 */
export function resolveRequestUrl(url: string, cfg: ApiEnvConfig | null | undefined): string {
  const resolved = resolveTemplate(url.trim(), cfg);
  if (/^https?:\/\//i.test(resolved) || !cfg?.baseUrl) return resolved;
  const base = resolveTemplate(cfg.baseUrl, cfg).replace(/\/+$/, "");
  return resolved.startsWith("/") ? base + resolved : `${base}/${resolved}`;
}

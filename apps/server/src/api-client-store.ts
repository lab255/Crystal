import fs from "node:fs/promises";
import path from "node:path";
import {
  ApiClientStateSchema,
  Emitter,
  createApiClientState,
  type ApiClientState,
  type ApiHeader,
  type ApiHttpResponse,
} from "@crystal/core";

/**
 * Persistence for the API-client workbench: one JSON file per workspace under
 * app data — deliberately NOT `.crystal/` in the repo, because environment
 * configs carry secrets and a committed plaintext token is a leak, not a
 * feature. Same serialized read-modify-write discipline as GrantsStore; a
 * corrupt/missing file degrades to an empty state.
 */
export class ApiClientStore {
  readonly events = new Emitter<{ changed: Record<string, never> }>();
  private queue: Promise<unknown> = Promise.resolve();
  private cached: ApiClientState | null = null;

  constructor(private readonly dataDir: string) {}

  private file(): string {
    return path.join(this.dataDir, "api-client.json");
  }

  async get(): Promise<{ state: ApiClientState }> {
    if (!this.cached) {
      try {
        const raw = JSON.parse(await fs.readFile(this.file(), "utf8"));
        this.cached = ApiClientStateSchema.parse(raw);
      } catch {
        this.cached = createApiClientState();
      }
    }
    return { state: this.cached };
  }

  /** Whole-state save, serialized; the change event fires after the write lands. */
  save(state: ApiClientState): Promise<{ ok: true }> {
    const next = ApiClientStateSchema.parse(state);
    const task = this.queue.then(async () => {
      await fs.mkdir(this.dataDir, { recursive: true });
      await fs.writeFile(this.file(), JSON.stringify(next, null, 2), "utf8");
      this.cached = next;
      this.events.emit("changed", {});
      return { ok: true as const };
    });
    this.queue = task.catch(() => {});
    return task;
  }
}

const SEND_TIMEOUT_MS = 30_000;
const MAX_BODY_BYTES = 1024 * 1024;

/**
 * Execute one HTTP request on the server (the webview can't reach localhost
 * APIs cross-origin). Transport failures return status 0 + error rather than
 * throwing — a refused connection is a result the response panel renders,
 * not a bridge error.
 */
export async function sendApiRequest(params: {
  method: string;
  url: string;
  headers?: ApiHeader[];
  body?: string | null;
}): Promise<ApiHttpResponse> {
  const started = Date.now();
  const fail = (error: string): ApiHttpResponse => ({
    status: 0,
    statusText: "",
    headers: [],
    body: "",
    durationMs: Date.now() - started,
    error,
  });

  let url: URL;
  try {
    url = new URL(params.url);
  } catch {
    return fail(`Not an absolute URL: ${params.url || "(empty)"} — set the environment's base URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return fail(`Unsupported protocol: ${url.protocol}`);
  }

  const method = params.method.toUpperCase();
  const headers = new Headers();
  for (const h of params.headers ?? []) {
    if (h.key.trim()) {
      try {
        headers.set(h.key.trim(), h.value);
      } catch {
        return fail(`Invalid header name: ${h.key}`);
      }
    }
  }
  const canHaveBody = method !== "GET" && method !== "HEAD";

  try {
    const res = await fetch(url, {
      method,
      headers,
      ...(canHaveBody && params.body != null ? { body: params.body } : {}),
      redirect: "follow",
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    const raw = await res.arrayBuffer();
    const truncated = raw.byteLength > MAX_BODY_BYTES;
    const body = new TextDecoder("utf-8", { fatal: false }).decode(
      truncated ? raw.slice(0, MAX_BODY_BYTES) : raw,
    );
    return {
      status: res.status,
      statusText: res.statusText,
      headers: [...res.headers.entries()].map(([key, value]) => ({ key, value })),
      body,
      ...(truncated ? { bodyTruncated: true } : {}),
      durationMs: Date.now() - started,
    };
  } catch (err) {
    const message =
      err instanceof Error && err.name === "TimeoutError"
        ? `Timed out after ${SEND_TIMEOUT_MS / 1000}s`
        : err instanceof Error
          ? (err.cause instanceof Error ? `${err.message}: ${err.cause.message}` : err.message)
          : String(err);
    return fail(message);
  }
}

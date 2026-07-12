import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";

/** Directory of this source file, resolved defensively (SEA/CJS-safe). */
function moduleDir(): string | null {
  try {
    return path.dirname(fileURLToPath(import.meta.url));
  } catch {
    return null;
  }
}

/**
 * Locate the built web console (`apps/web/dist`). Checked in order:
 *   1. `CRYSTAL_CONSOLE_DIR` — explicit override (set by the Docker image).
 *   2. `<serverPkg>/web-dist` — staged next to the built server (Docker build).
 *   3. `apps/web/dist` relative to this source file — the `tsx` dev fallback.
 * Returns null when no bundle is present; the server then runs API-only.
 */
export function resolveConsoleDir(): string | null {
  const here = moduleDir();
  const candidates = [
    process.env.CRYSTAL_CONSOLE_DIR,
    here ? path.resolve(here, "..", "web-dist") : null,
    here ? path.resolve(here, "..", "..", "web", "dist") : null,
  ].filter((p): p is string => Boolean(p));
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "index.html"))) return dir;
  }
  return null;
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
};

export type ConsoleHandler = (req: IncomingMessage, res: ServerResponse) => void;

/**
 * A tiny static file server for the built web console — no dependency on
 * express/serve-static (the bridge server intentionally stays dep-light).
 * Serves files under `dir` with a single-page-app fallback to index.html,
 * guarding against path traversal (same shape as `paths.ts:resolveInRoot`).
 * Callers gate auth *before* delegating here; this only serves bytes.
 */
export function createConsoleHandler(
  dir: string | null = resolveConsoleDir(),
): ConsoleHandler {
  return function serveConsole(req, res) {
    if (!dir) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("Console bundle not found");
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405);
      res.end();
      return;
    }

    const pathname = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
    const rel = pathname.replace(/^\/+/, "");
    let abs = path.resolve(dir, rel);

    // Path-traversal guard: the resolved path must stay inside `dir`.
    if (abs !== dir && !abs.startsWith(dir + path.sep)) {
      res.writeHead(403);
      res.end();
      return;
    }

    const hit = rel !== "" && fs.existsSync(abs) && fs.statSync(abs).isFile();
    if (!hit) {
      const missExt = path.extname(abs).toLowerCase();
      // A missing asset (has a real extension) is a 404 — don't serve the HTML
      // shell for a broken `.js`/`.css` request. Extensionless paths are SPA
      // routes and fall through to index.html.
      if (missExt && missExt !== ".html") {
        res.writeHead(404);
        res.end();
        return;
      }
      abs = path.join(dir, "index.html");
    }

    const ext = path.extname(abs).toLowerCase();
    const isIndex = abs === path.join(dir, "index.html");
    res.writeHead(200, {
      "content-type": CONTENT_TYPES[ext] ?? "application/octet-stream",
      // index.html must revalidate (it references content-hashed assets); the
      // hashed assets themselves are immutable.
      "cache-control": isIndex ? "no-cache" : "public, max-age=31536000, immutable",
    });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    fs.createReadStream(abs).pipe(res);
  };
}

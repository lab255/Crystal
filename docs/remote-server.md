# Running Crystal as a remote server + web console

Crystal's bridge server can run on a box and be driven from a browser: it binds
to a configurable host, **serves its own web console same-origin**, and gates
everything behind a bearer token. The URL you open *is* the console — no
separately-hosted front end, no CORS to configure.

> The server exposes filesystem, git, terminal, and agent (`claude`) execution
> for its workspaces. Treat the token as a **root credential** and always front
> a remote deployment with TLS.

## How auth works

- **Loopback (`127.0.0.1`, the default)** — auth is **off**. This keeps the
  desktop app and `pnpm dev` working with zero config.
- **Any non-loopback host** — a token is **required**. Set `CRYSTAL_TOKEN`, or
  the server generates one at startup and prints it (and a ready-to-open
  `…/?token=…` URL) to stdout.

The token rides the console URL as `?token=…`. On first load the server
promotes it to an `HttpOnly; SameSite=Strict` cookie and redirects to the clean
path, so it leaves the address bar/history and never reaches app JS. That
cookie then authenticates asset loads and the WebSocket upgrade. Non-browser
clients may instead send `Authorization: Bearer <token>` or `?token=`. The
WebSocket upgrade also enforces an **Origin allow-list** (same-origin by
default; widen with `CRYSTAL_ALLOWED_ORIGINS`) to block cross-site hijacking.

## Configuration

| Env / flag | Default | Purpose |
| --- | --- | --- |
| `--host` / `CRYSTAL_HOST` | `127.0.0.1` | Interface to bind. `0.0.0.0` to expose. |
| `--port` / `CRYSTAL_PORT` | `4517` | Listen port. |
| `--root` (repeatable) | cwd | Workspace root(s) to open. |
| `CRYSTAL_TOKEN` | — | Bearer token. Auto-generated on a non-loopback bind if unset. |
| `CRYSTAL_CONSOLE_DIR` | auto | Directory of the built web console (`apps/web/dist`). |
| `CRYSTAL_ALLOWED_ORIGINS` | same-origin | Comma-separated extra Origins allowed to open the WS. |

`/health` stays unauthenticated (for readiness probes) and returns only
`{ ok: true }` once a token is configured.

## Docker

```bash
docker build -t crystal .
docker run --rm -p 4517:4517 \
  -e CRYSTAL_TOKEN=$(openssl rand -hex 24) \
  -v "$PWD:/workspace" \
  -v crystal-state:/data \
  crystal
```

Open `http://<host>:4517/?token=<token>`. Notes:

- The image runs the server under a normal Node runtime (`tsx`), so node-pty's
  native addon resolves normally — the desktop's SEA constraint doesn't apply.
- `/workspace` is the project root the server opens; `/data` holds `~/.crystal`
  state (open-workspace set, per-workspace run history). Mount both to persist.
- Agent runs need Anthropic credentials for the bundled `claude` CLI — mount
  `~/.claude` or pass the CLI's auth env.

## Appliance

[`appliance.json`](../appliance.json) is a `container`-type manifest, so the
server deploys via the reference platform:

```bash
appliance env set CRYSTAL_TOKEN=<token> CRYSTAL_HOST=0.0.0.0
appliance deploy crystal <env>
```

The appliance ingress terminates TLS and routes to port 4517, so the browser
loads `https://…` and the client opens `wss://…/crystal` same-origin — the
server stays plain http/ws behind it. Keep **one replica**: terminals and agent
runs are in-process and are not shared across replicas.

## Bare Node

```bash
pnpm --filter @crystal/web build            # build the console once
CRYSTAL_TOKEN=<token> CRYSTAL_HOST=0.0.0.0 CRYSTAL_CONSOLE_DIR=apps/web/dist \
  pnpm --filter @crystal/server start --root /path/to/project
```

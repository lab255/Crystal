---
name: verify
description: Verify Crystal changes end-to-end by driving the bridge server's WebSocket surface (and the Vite web app for UI changes).
---

# Verifying Crystal changes

## Bridge server (covers core/server/bridge-method changes)

Start an isolated server instance — **never reuse 4517** (the user's dev
server) and check the port is free first; a stale instance answers `/health`
with old code:

```powershell
pnpm --filter @crystal/server exec tsx src/index.ts --root "<repo root>" --port 4611
# ready when http://127.0.0.1:4611/health returns {"ok":true,"roots":[...]}
```

Drive it with a Node script over `ws://127.0.0.1:<port>/crystal`. Protocol:
send `{id, type:"req", method, params}`, match `{id, type:"res", ok, result|error}`.
Resolve the `ws` package via `createRequire("<repo>/apps/server/package.json")`
— plain `node script.mjs` from a temp dir can't see the workspace's
node_modules.

- Methods needing another workspace: `workspaces.open {root}` → use the
  returned id as `params.ws`, and `workspaces.close` it when done (the open
  set persists to `~/.crystal/open-workspaces.json`).
- Destructive methods (`refactor.apply`, `fs.write`…): drive them against a
  scratch fixture workspace (temp dir with a `package.json`), never the repo.
- The code map is lazy — first `codemap.*` call analyzes; ~1s on this repo.

## Web UI

`pnpm dev:web` serves http://localhost:5173 (expects the bridge on 4517).
Browser automation that works here: `npm i playwright` in the scratchpad, then
`chromium.launch({ channel: "msedge", headless: true })` — no browser download
needed. Frontend packages are served as TS source with HMR, so when the user's
dev stack is already up on 5173/4517 it serves your edited code as-is; a fresh
Playwright context has clean localStorage (split sizes, nav state), and
read-only clicking in your own context is safe alongside the user's session.
Drive selection via deep links (`#/architect/systems?system=…`) instead of
canvas clicks — react-flow nodes overlap and swallow pointer events.

## Gotchas

- Kill the tsx server with TaskStop before editing server code — it is NOT
  watch mode when started as above.
- TaskStop kills only the pnpm wrapper; the tsx child keeps listening and a
  restart on the same port silently talks to the OLD code. After stopping,
  find the real listener (`netstat -ano | findstr :<port>` → LISTENING row)
  and `Stop-Process -Id <pid> -Force`, then re-check `/health`.
- `getApplicableRefactors`' 5th arg is a refactor *kind* ("refactor.move.file"),
  not a display name — a wrong value silently disables the LS path (bit us once).
- The code-map summary method is `codemap.get` (there is no `codemap.summary`),
  and `workspaces.open` resolves to `{ workspace: { id, root, name } }` — the
  ws id for scoped calls is `result.workspace.id`.

# Crystal remote bridge server + web console.
#
# Deliberately a normal Node runtime (tsx over the TS source), NOT the desktop's
# Node SEA sidecar: in a container node-pty's native addon resolves from
# node_modules the normal way, so the SEA blocker doesn't apply. Packages are
# consumed as TypeScript source (no per-package build), so only the web console
# is built ahead of time.

# ---------- build ----------
FROM node:24-bookworm-slim AS build
RUN corepack enable
WORKDIR /crystal

# Manifests first for a cached install layer. Drop the use-node-version pin so
# pnpm uses the base image's Node 24 instead of re-downloading 24.18.0.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN sed -i '/use-node-version/d' .npmrc
COPY apps/server/package.json      apps/server/
COPY apps/web/package.json         apps/web/
COPY apps/desktop/package.json     apps/desktop/
COPY packages/architect/package.json    packages/architect/
COPY packages/client/package.json       packages/client/
COPY packages/core/package.json         packages/core/
COPY packages/editor/package.json       packages/editor/
COPY packages/orchestrator/package.json packages/orchestrator/
COPY packages/sdk/package.json          packages/sdk/
COPY packages/ui/package.json           packages/ui/
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

COPY . .
RUN sed -i '/use-node-version/d' .npmrc
# Build the web console (Vite compiles the workspace UI packages from source),
# then stage it next to the server where resolveConsoleDir() looks for it.
RUN pnpm --filter @crystal/web build && cp -r apps/web/dist apps/server/web-dist

# ---------- runtime ----------
FROM node:24-bookworm-slim AS runtime
# git + bash back the git/terminal bridge methods; the claude CLI backs agent.start.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git bash ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN corepack enable && npm install -g @anthropic-ai/claude-code
WORKDIR /crystal
COPY --from=build /crystal ./
ENV CRYSTAL_HOST=0.0.0.0 \
    CRYSTAL_PORT=4517 \
    CRYSTAL_CONSOLE_DIR=/crystal/apps/server/web-dist \
    HOME=/data
# CRYSTAL_TOKEN is supplied at run time (never baked in). If unset, the server
# generates one and prints it — visible in `docker logs`.
EXPOSE 4517
VOLUME ["/data", "/workspace"]
CMD ["pnpm", "--filter", "@crystal/server", "exec", "tsx", "src/index.ts", \
     "--host", "0.0.0.0", "--port", "4517", "--root", "/workspace"]

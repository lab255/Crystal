# Harborview

Harborview is a small ferry & marina booking platform. Customers search coastal
sailings, quote fares, and book crossings; background workers capture payments and
send confirmation emails.

## Layout

This is a pnpm/npm workspace monorepo:

| Path              | Package             | Role                                              |
| ----------------- | ------------------- | ------------------------------------------------- |
| `packages/core`   | `@harborview/core`  | Domain types, fare pricing, booking & cancellation logic (pure TS). |
| `packages/db`     | `@harborview/db`    | Repository layer over Postgres (`pg`).            |
| `packages/queue`  | `@harborview/queue` | Redis-backed job queue (`ioredis`): publisher + consumer. |
| `services/api`    | `@harborview/api`   | HTTP API (`express`, `zod`, `pino`). Entry `src/index.ts`. |
| `services/worker` | `@harborview/worker`| Job worker: email + payment capture. Entry `src/index.ts`. |
| `apps/web`        | `@harborview/web`   | React SPA. Entry `src/main.tsx`.                  |

## Data & control flow

- **web → api**: the SPA calls the API over HTTP through a small `fetch` client.
- **api → db / queue**: handlers run core logic, persist via repositories, and enqueue jobs.
- **queue → worker**: the worker consumes jobs to capture payments and dispatch email.
- **api ← worker**: payment webhooks flip bookings to `confirmed`.

Config (Postgres / Redis URLs, ports, secrets) is read from environment variables in
each service's `config.ts`.

> This repo is a fixture for Crystal's code-map analyzer. It is never installed or
> built; the external dependencies (`express`, `react`, `pg`, …) are declared but not present.

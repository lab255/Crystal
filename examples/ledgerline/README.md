# Ledgerline

Ledgerline is a small invoicing & ledger SaaS. Organizations issue invoices to
customers; payments post double-entry ledger entries; a background worker chases
overdue invoices (dunning) and mails monthly statements; an admin SPA browses it all.

## Layout

An npm-workspaces monorepo, flatter than a `packages/`-style layout:

| Path      | Package               | Role                                                        |
| --------- | --------------------- | ----------------------------------------------------------- |
| `shared/` | `@ledgerline/shared`  | Money math, time helpers, ids, `Result` type (pure TS).      |
| `server/` | `@ledgerline/server`  | HTTP API: auth (sessions + API tokens), handlers, ledger.    |
| `worker/` | `@ledgerline/worker`  | Dunning runs, monthly statements, outbound mail.             |
| `admin/`  | `@ledgerline/admin`   | React admin SPA. Entry `src/main.tsx`.                       |

## Data & control flow

- **admin → server**: the SPA calls the API through a small `fetch` client.
- **server → ledger**: invoice/payment handlers post double-entry ledger entries.
- **worker**: scans for overdue invoices, sends dunning mail and monthly statements.

> This repo is a fixture for Crystal's code-map analyzer and review engine. It is
> never installed or built; external deps are declared but not present. It contains
> a few *deliberate* code smells (duplicated helpers, a cross-package relative
> import, unused exports, a dead file) that the review tooling should surface.

# Driftwood

A single-package log-analysis CLI: parse access logs, filter, aggregate, and
print a report. Fixture for Crystal's code map — exercises the *single-module*
path (no workspaces; the whole repo is one module). Contains a deliberate
duplicate (`percentile`), a dead file (`legacy.ts`), and unused exports.

```
driftwood access.log --status 500 --by route
```

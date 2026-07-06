/**
 * Semantic file roles, inferred from module-relative paths. Roles drive the
 * "neat" auto-layout: backend modules band controller → service → data,
 * frontend modules band provider → layout → component → query (queries sit
 * last — closest to the API boundary). Everything is a path/name heuristic;
 * nothing is persisted, so the banding follows the code as it moves.
 */

export type CodeRole =
  | "entry" // routes, controllers, handlers, middleware — the request surface
  | "service" // business logic, domain, workers, processors
  | "data" // repos, db clients, migrations, queues, caches
  | "provider" // frontend contexts/providers/state stores
  | "layout" // frontend layouts, pages, app shells, routers
  | "component" // frontend components and hooks
  | "query" // frontend data access: api clients, queries/mutations
  | "other";

export type ModuleFlavor = "frontend" | "backend";

/** Band order per flavor — top (or leftmost) band first. */
export const ROLE_BANDS: Record<ModuleFlavor, readonly CodeRole[]> = {
  backend: ["entry", "service", "data", "other"],
  frontend: ["provider", "layout", "component", "query", "other"],
};

const BACKEND_ROLE_TOKENS: Record<string, CodeRole> = tokenTable({
  entry: [
    "route", "routes", "router", "routers", "controller", "controllers",
    "handler", "handlers", "endpoint", "endpoints", "middleware", "middlewares",
    "gateway", "server", "app", "api", "resolver", "resolvers", "rpc", "trpc",
    "webhook", "webhooks",
  ],
  service: [
    "service", "services", "logic", "domain", "usecase", "usecases", "core",
    "worker", "workers", "processor", "processors", "job", "jobs", "dispatcher",
    "manager", "engine", "pipeline", "command", "commands", "mutator", "mutators",
  ],
  data: [
    "repo", "repos", "repository", "repositories", "db", "database", "sql",
    "migration", "migrations", "schema", "schemas", "model", "models",
    "entity", "entities", "dao", "storage", "store", "stores", "cache",
    "persistence", "prisma", "drizzle", "orm", "queue", "queues", "redis",
  ],
});

const FRONTEND_ROLE_TOKENS: Record<string, CodeRole> = tokenTable({
  provider: [
    "provider", "providers", "context", "contexts", "store", "stores",
    "state", "atom", "atoms", "redux", "zustand",
  ],
  layout: [
    "layout", "layouts", "page", "pages", "screen", "screens", "view", "views",
    "app", "shell", "navigation", "router", "routers", "route", "routes",
  ],
  query: [
    "api", "apis", "client", "clients", "query", "queries", "mutation",
    "mutations", "fetch", "fetcher", "graphql", "trpc", "swr", "request",
    "requests", "http", "endpoint", "endpoints",
  ],
  component: [
    "component", "components", "ui", "widget", "widgets", "element",
    "elements", "hook", "hooks",
  ],
});

function tokenTable(groups: Partial<Record<CodeRole, string[]>>): Record<string, CodeRole> {
  const out: Record<string, CodeRole> = {};
  for (const [role, tokens] of Object.entries(groups)) {
    for (const t of tokens!) out[t] = role as CodeRole;
  }
  return out;
}

/**
 * Tokens of a module-relative path, most specific first: basename parts
 * (split on `.`/`-`/`_`, extension dropped), then directories innermost-out.
 * "handlers/booking.repo.ts" → ["booking", "repo", "handlers"].
 */
function tokensOf(relPath: string): string[] {
  const segments = relPath.toLowerCase().split("/").filter(Boolean);
  if (segments.length === 0) return [];
  const base = segments[segments.length - 1]!.replace(/\.[a-z0-9]+$/, "");
  const dirs = segments.slice(0, -1).reverse();
  return [...base.split(/[._-]/).filter(Boolean), ...dirs];
}

/**
 * A module is frontend-flavored when a meaningful share of its files are
 * JSX/TSX (React trees classify by UI hierarchy, not request tiers). The
 * quarter threshold keeps a stray email template from flipping a backend
 * module.
 */
export function moduleFlavorOf(relPaths: readonly string[]): ModuleFlavor {
  if (relPaths.length === 0) return "backend";
  const jsx = relPaths.filter((p) => /\.[jt]sx$/i.test(p)).length;
  return jsx / relPaths.length > 0.25 ? "frontend" : "backend";
}

/**
 * Role of one file. The nearest matching token wins — basename parts first,
 * then directories innermost-out — so "db/migrations.ts" is data via its
 * basename while "handlers/booking.ts" falls through to its directory.
 */
export function roleOfFile(relPath: string, flavor: ModuleFlavor): CodeRole {
  const table = flavor === "frontend" ? FRONTEND_ROLE_TOKENS : BACKEND_ROLE_TOKENS;
  for (const token of tokensOf(relPath)) {
    const role = table[token];
    if (role) return role;
  }
  if (flavor === "frontend" && /\.[jt]sx$/i.test(relPath)) return "component";
  return "other";
}

/** Band index of a role within its flavor's order; unknown roles sink last. */
export function roleRank(role: CodeRole, flavor: ModuleFlavor): number {
  const idx = ROLE_BANDS[flavor].indexOf(role);
  return idx === -1 ? ROLE_BANDS[flavor].length : idx;
}

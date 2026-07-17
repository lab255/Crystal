import type { ArchNodeKind } from "./architecture.js";

/**
 * External service detection — classifying the bare npm imports a codebase
 * makes into the external services they imply (databases, caches, queues,
 * SaaS APIs…). This is what lets the infrastructure view behave like a
 * service map: internal modules are edges in the import graph, and the
 * packages below are the tell-tale client libraries of everything else the
 * system talks to. Pure and data-driven so it is unit-testable and usable by
 * both the server analyzer and the UI.
 */

export const EXTERNAL_SERVICE_CATEGORIES = [
  "database",
  "cache",
  "queue",
  "storage",
  "http",
  "auth",
  "payments",
  "ai",
  "email",
  "monitoring",
  "search",
  "realtime",
] as const;
export type ExternalServiceCategory = (typeof EXTERNAL_SERVICE_CATEGORIES)[number];

/** How each category renders on the architecture/infra canvas. */
export const ARCH_KIND_OF_CATEGORY: Record<ExternalServiceCategory, ArchNodeKind> = {
  database: "datastore",
  cache: "cache",
  queue: "queue",
  storage: "datastore",
  http: "external",
  auth: "external",
  payments: "external",
  ai: "external",
  email: "external",
  monitoring: "external",
  search: "datastore",
  realtime: "queue",
};

export interface ExternalServiceMeta {
  /** Stable id, e.g. "postgres", "redis", "stripe". */
  id: string;
  /** Display name, e.g. "PostgreSQL". */
  name: string;
  category: ExternalServiceCategory;
}

interface ServiceRule extends ExternalServiceMeta {
  /** Exact package names implying this service. */
  packages?: string[];
  /** Package-name prefixes implying this service (e.g. "@aws-sdk/client-s3"). */
  prefixes?: string[];
}

/**
 * The registry maps well-known client libraries to the service they talk to.
 * ORMs and query builders count as their most likely backing store — the map
 * is a review aid, not an inventory; the node label carries the package names
 * so a mis-guess is visible and correctable.
 */
const SERVICE_RULES: ServiceRule[] = [
  // --- databases ---
  { id: "postgres", name: "PostgreSQL", category: "database", packages: ["pg", "postgres", "pg-promise", "@vercel/postgres", "@neondatabase/serverless"] },
  { id: "mysql", name: "MySQL", category: "database", packages: ["mysql", "mysql2", "@planetscale/database"] },
  { id: "sqlite", name: "SQLite", category: "database", packages: ["sqlite3", "better-sqlite3", "sql.js", "@libsql/client"] },
  { id: "mongodb", name: "MongoDB", category: "database", packages: ["mongodb", "mongoose"] },
  { id: "dynamodb", name: "DynamoDB", category: "database", packages: ["@aws-sdk/client-dynamodb", "@aws-sdk/lib-dynamodb", "dynamoose"] },
  { id: "sql-orm", name: "SQL database", category: "database", packages: ["prisma", "@prisma/client", "drizzle-orm", "typeorm", "sequelize", "knex", "kysely", "mikro-orm", "@mikro-orm/core"] },
  { id: "supabase", name: "Supabase", category: "database", packages: ["@supabase/supabase-js"], prefixes: ["@supabase/"] },
  { id: "firebase", name: "Firebase", category: "database", packages: ["firebase", "firebase-admin"], prefixes: ["@firebase/"] },
  // --- caches ---
  { id: "redis", name: "Redis", category: "cache", packages: ["redis", "ioredis", "@upstash/redis", "@redis/client"] },
  { id: "memcached", name: "Memcached", category: "cache", packages: ["memcached", "memjs"] },
  // --- queues / streams ---
  { id: "kafka", name: "Kafka", category: "queue", packages: ["kafkajs", "node-rdkafka", "@confluentinc/kafka-javascript"] },
  { id: "rabbitmq", name: "RabbitMQ", category: "queue", packages: ["amqplib", "amqp-connection-manager", "rascal"] },
  { id: "redis-queue", name: "Redis queue", category: "queue", packages: ["bullmq", "bull", "bee-queue"] },
  { id: "sqs", name: "SQS", category: "queue", packages: ["@aws-sdk/client-sqs", "sqs-consumer", "sqs-producer"] },
  { id: "nats", name: "NATS", category: "queue", packages: ["nats"] },
  { id: "mqtt", name: "MQTT broker", category: "queue", packages: ["mqtt", "async-mqtt"] },
  // --- object storage ---
  { id: "s3", name: "S3", category: "storage", packages: ["@aws-sdk/client-s3", "aws-sdk", "minio", "@aws-sdk/s3-request-presigner"] },
  { id: "gcs", name: "Cloud Storage", category: "storage", packages: ["@google-cloud/storage"] },
  { id: "azure-blob", name: "Azure Blob", category: "storage", packages: ["@azure/storage-blob"] },
  // --- generic outbound HTTP ---
  { id: "http", name: "HTTP APIs", category: "http", packages: ["axios", "got", "node-fetch", "undici", "ky", "superagent", "graphql-request", "@urql/core", "@apollo/client"] },
  // --- auth providers ---
  { id: "auth", name: "Auth provider", category: "auth", packages: ["next-auth", "passport", "auth0", "@auth0/nextjs-auth0", "@okta/okta-sdk-nodejs", "jsonwebtoken", "jose"], prefixes: ["@clerk/", "@auth/"] },
  // --- payments ---
  { id: "stripe", name: "Stripe", category: "payments", packages: ["stripe"], prefixes: ["@stripe/"] },
  { id: "payments", name: "Payments", category: "payments", packages: ["braintree", "square", "@paypal/checkout-server-sdk", "razorpay"] },
  // --- AI / LLM ---
  { id: "anthropic", name: "Anthropic API", category: "ai", packages: ["@anthropic-ai/sdk", "@anthropic-ai/claude-agent-sdk", "@anthropic-ai/bedrock-sdk"] },
  { id: "openai", name: "OpenAI API", category: "ai", packages: ["openai"] },
  { id: "ai", name: "LLM APIs", category: "ai", packages: ["ai", "@google/generative-ai", "@google/genai", "cohere-ai", "groq-sdk", "ollama", "@mistralai/mistralai", "langchain"], prefixes: ["@langchain/"] },
  // --- email ---
  { id: "email", name: "Email", category: "email", packages: ["nodemailer", "@sendgrid/mail", "postmark", "resend", "mailgun.js", "@aws-sdk/client-ses"] },
  // --- monitoring / telemetry ---
  { id: "sentry", name: "Sentry", category: "monitoring", prefixes: ["@sentry/"] },
  { id: "monitoring", name: "Telemetry", category: "monitoring", packages: ["dd-trace", "prom-client", "newrelic", "statsd-client", "hot-shots", "posthog-node", "posthog-js", "@amplitude/analytics-node"], prefixes: ["@opentelemetry/"] },
  // --- search ---
  { id: "elasticsearch", name: "Elasticsearch", category: "search", packages: ["@elastic/elasticsearch", "elasticsearch"] },
  { id: "search", name: "Search", category: "search", packages: ["algoliasearch", "meilisearch", "typesense"] },
  // --- realtime ---
  { id: "realtime", name: "Realtime", category: "realtime", packages: ["pusher", "pusher-js", "ably", "socket.io", "socket.io-client"] },
];

const byPackage = new Map<string, ExternalServiceMeta>();
const byPrefix: { prefix: string; meta: ExternalServiceMeta }[] = [];
for (const { packages, prefixes, ...meta } of SERVICE_RULES) {
  for (const pkg of packages ?? []) byPackage.set(pkg, meta);
  for (const prefix of prefixes ?? []) byPrefix.push({ prefix, meta });
}

/** Service implied by one npm package name, or null for plain libraries. */
export function classifyExternalPackage(pkg: string): ExternalServiceMeta | null {
  const exact = byPackage.get(pkg);
  if (exact) return exact;
  for (const { prefix, meta } of byPrefix) {
    if (pkg.startsWith(prefix)) return meta;
  }
  return null;
}

/** One detected external service and the modules that import its client libraries. */
export interface CodeExternalDep {
  /** Stable service id (`ExternalServiceMeta.id`). */
  id: string;
  name: string;
  category: ExternalServiceCategory;
  /** Package names that implied this service, most-imported first. */
  packages: string[];
  /** Importing modules with import-statement counts, heaviest first. */
  clients: { module: string; weight: number }[];
  /** Total import statements across all clients. */
  weight: number;
}

/** Node builtins — runtime platform, not dependencies worth mapping. */
const NODE_BUILTINS = new Set([
  "assert", "async_hooks", "buffer", "child_process", "cluster", "console",
  "constants", "crypto", "dgram", "dns", "events", "fs", "http", "http2",
  "https", "inspector", "module", "net", "os", "path", "perf_hooks",
  "process", "punycode", "querystring", "readline", "repl", "stream",
  "string_decoder", "timers", "tls", "tty", "url", "util", "v8", "vm",
  "worker_threads", "zlib",
]);

/** True for imports that say nothing about what the code leans on. */
export function isPlatformImport(pkg: string): boolean {
  return pkg.startsWith("node:") || NODE_BUILTINS.has(pkg) || pkg.startsWith("@types/");
}

/**
 * One plain npm library and the modules importing it. The complement of the
 * service map: WASM kernels, UI frameworks, math libraries — everything a
 * codebase leans on that isn't a backing service. In library-heavy apps
 * (games, CAD, editors) this IS the external story; the service registry
 * alone would report nothing.
 */
export interface CodeLibraryDep {
  /** Package name as imported ("three", "@react-three/fiber"). */
  pkg: string;
  /** Total import statements across all clients. */
  weight: number;
  /** Importing modules with import-statement counts, heaviest first. */
  clients: { module: string; weight: number }[];
}

/**
 * Aggregate plain-library imports per package, heaviest first. Packages the
 * service registry recognizes are excluded — they surface via
 * {@link aggregateExternalDeps} instead — as are node builtins and `@types/*`.
 */
export function aggregateExternalLibraries(
  imports: Iterable<{ module: string; pkg: string }>,
  cap = 20,
): CodeLibraryDep[] {
  const byPkg = new Map<string, Map<string, number>>();
  for (const { module, pkg } of imports) {
    if (isPlatformImport(pkg) || classifyExternalPackage(pkg)) continue;
    let clients = byPkg.get(pkg);
    if (!clients) byPkg.set(pkg, (clients = new Map()));
    clients.set(module, (clients.get(module) ?? 0) + 1);
  }
  return [...byPkg.entries()]
    .map(([pkg, clients]) => {
      const clientList = [...clients.entries()]
        .map(([module, weight]) => ({ module, weight }))
        .sort((a, b) => b.weight - a.weight || a.module.localeCompare(b.module));
      return { pkg, clients: clientList, weight: clientList.reduce((s, c) => s + c.weight, 0) };
    })
    .sort((a, b) => b.weight - a.weight || a.pkg.localeCompare(b.pkg))
    .slice(0, cap);
}

/**
 * Aggregate raw (module, package) import observations into per-service
 * dependencies. Unrecognized packages are ignored — plain libraries are not
 * services.
 */
export function aggregateExternalDeps(
  imports: Iterable<{ module: string; pkg: string }>,
): CodeExternalDep[] {
  const services = new Map<
    string,
    { meta: ExternalServiceMeta; packages: Map<string, number>; clients: Map<string, number> }
  >();
  for (const { module, pkg } of imports) {
    const meta = classifyExternalPackage(pkg);
    if (!meta) continue;
    let entry = services.get(meta.id);
    if (!entry) {
      entry = { meta, packages: new Map(), clients: new Map() };
      services.set(meta.id, entry);
    }
    entry.packages.set(pkg, (entry.packages.get(pkg) ?? 0) + 1);
    entry.clients.set(module, (entry.clients.get(module) ?? 0) + 1);
  }
  return [...services.values()]
    .map(({ meta, packages, clients }) => {
      const clientList = [...clients.entries()]
        .map(([module, weight]) => ({ module, weight }))
        .sort((a, b) => b.weight - a.weight || a.module.localeCompare(b.module));
      return {
        ...meta,
        packages: [...packages.entries()]
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .map(([pkg]) => pkg),
        clients: clientList,
        weight: clientList.reduce((sum, c) => sum + c.weight, 0),
      };
    })
    .sort((a, b) => b.weight - a.weight || a.name.localeCompare(b.name));
}

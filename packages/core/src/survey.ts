import { z } from "zod";
import { uid } from "./ids.js";
import {
  ArchEdgeKindSchema,
  ArchLayerSchema,
  ArchNodeKindSchema,
  CONTAINER_KINDS,
  createLocalEnvironment,
  topoOrderNodes,
  type ArchEnvironment,
  type ArchNode,
  type ArchitectureGraph,
} from "./architecture.js";

/**
 * Architecture survey — the interchange format agents (and external tools)
 * emit after crawling a codebase or an IaC repo. It is deliberately decoupled
 * from the canvas model: no positions, no renderer concerns — just components,
 * relations, suggested deployments and journeys, each carrying evidence so a
 * human can audit where a claim came from.
 *
 * Compatibility contract:
 *  - `schemaVersion` versions this payload independently of the file envelope;
 *    older payloads are migrated on read (see `migrateSurveyData`), newer ones
 *    are rejected with a clear error.
 *  - Reads are tolerant: unknown enum values degrade to safe fallbacks via
 *    `.catch()`, missing optional fields take defaults, and unknown extra
 *    fields are ignored — a v1 reader survives a well-meaning v1.5 writer.
 */

export const SURVEY_SCHEMA_VERSION = 1;

/** What the surveying agent looked at. */
export const SurveySourceSchema = z.object({
  /** "codebase" = crawled application source; "iac" = read infra-as-code. */
  kind: z.enum(["codebase", "iac"]).catch("codebase"),
  /** Workspace-relative root that was surveyed ("." for the whole repo). */
  root: z.string().default("."),
  /** One-paragraph description of what the system is and does. */
  summary: z.string().default(""),
});
export type SurveySource = z.infer<typeof SurveySourceSchema>;

export const SurveyComponentSchema = z.object({
  /** Survey-local stable id (slug); referenced by relations and placements. */
  id: z.string(),
  name: z.string(),
  /** Unknown kinds from future writers degrade to "service". */
  kind: ArchNodeKindSchema.catch("service"),
  description: z.string().default(""),
  /** Survey-local id of the containing component, when nested. */
  parentId: z.string().nullish(),
  tech: z.array(z.string()).default([]),
  layer: ArchLayerSchema.nullish().catch(null),
  /** Workspace-relative module path backing this component, when known. */
  codeModule: z.string().nullish(),
  /** Workspace-relative file backing this component, when finer than a module. */
  codeFile: z.string().nullish(),
  /** Files/paths/config keys that justify this component's existence. */
  evidence: z.array(z.string()).default([]),
  /** Surveyor's confidence, 0–1. */
  confidence: z.number().min(0).max(1).catch(1).default(1),
});
export type SurveyComponent = z.infer<typeof SurveyComponentSchema>;

export const SurveyRelationSchema = z.object({
  /** Survey-local component ids. */
  source: z.string(),
  target: z.string(),
  kind: ArchEdgeKindSchema.catch("sync"),
  label: z.string().default(""),
  evidence: z.array(z.string()).default([]),
});
export type SurveyRelation = z.infer<typeof SurveyRelationSchema>;

/** One suggested (or observed, for IaC) deployment environment. */
export const SurveyDeploymentSchema = z.object({
  /** Environment name, e.g. "Production". */
  environment: z.string(),
  kind: z.enum(["local", "cloud"]).catch("cloud"),
  /** The deployment pattern in one line, e.g. "Three-tier on ECS behind ALB". */
  pattern: z.string().default(""),
  /** Why this pattern fits (or, for IaC, what the code encodes). */
  rationale: z.string().default(""),
  placements: z
    .array(
      z.object({
        /** Survey-local component id. */
        componentId: z.string(),
        /** Deployment target, e.g. "aws us-east-1 / ecs", "vercel". */
        target: z.string(),
        /** Runtime detail, e.g. "fargate ×3", "lambda". */
        runtime: z.string().default(""),
      }),
    )
    .default([]),
});
export type SurveyDeployment = z.infer<typeof SurveyDeploymentSchema>;

export const SurveyJourneySchema = z.object({
  name: z.string(),
  description: z.string().default(""),
  entry: z.object({
    /** Workspace-relative file path. */
    file: z.string(),
    /** Top-level symbol name within that file. */
    symbol: z.string(),
  }),
});
export type SurveyJourney = z.infer<typeof SurveyJourneySchema>;

export const ArchSurveySchema = z.object({
  schemaVersion: z.number().int().min(1),
  generator: z
    .object({ name: z.string(), version: z.string().default("") })
    .default({ name: "unknown", version: "" }),
  /** ISO timestamp; informational only. */
  generatedAt: z.string().default(""),
  source: SurveySourceSchema,
  components: z.array(SurveyComponentSchema).default([]),
  relations: z.array(SurveyRelationSchema).default([]),
  deployments: z.array(SurveyDeploymentSchema).default([]),
  journeys: z.array(SurveyJourneySchema).default([]),
  /** Anything the surveyor wants a human to read (caveats, unknowns). */
  notes: z.array(z.string()).default([]),
});
export type ArchSurvey = z.infer<typeof ArchSurveySchema>;

/**
 * Per-version data migrations for the survey payload: `migrations[n]` upgrades
 * a version-n payload to n+1 (and must bump `schemaVersion` itself). Applied
 * in sequence by `migrateSurveyData` until the payload reaches
 * `SURVEY_SCHEMA_VERSION`. v1 is the initial version, so the table is empty.
 */
export const SURVEY_MIGRATIONS: Record<number, (data: unknown) => unknown> = {};

export class SurveyVersionError extends Error {}

/** Upgrade an older survey payload to the current schema version. */
export function migrateSurveyData(
  raw: unknown,
  migrations: Record<number, (data: unknown) => unknown> = SURVEY_MIGRATIONS,
  currentVersion: number = SURVEY_SCHEMA_VERSION,
): unknown {
  const version = (raw as { schemaVersion?: unknown })?.schemaVersion;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    throw new SurveyVersionError("Survey payload is missing an integer schemaVersion");
  }
  if (version > currentVersion) {
    throw new SurveyVersionError(
      `Survey schemaVersion ${version} is newer than this build supports (${currentVersion})`,
    );
  }
  let data = raw;
  for (let v = version; v < currentVersion; v++) {
    const step = migrations[v];
    if (!step) {
      throw new SurveyVersionError(`No migration from survey schemaVersion ${v}`);
    }
    data = step(data);
  }
  return data;
}

export interface SurveyImportResult {
  graph: ArchitectureGraph;
  /** Human-readable notes about anything skipped or coerced during import. */
  warnings: string[];
}

const GRID_COLS = 4;
const ROOT_STEP = { x: 380, y: 280 };
const CHILD_COLS = 3;
const CHILD_STEP = { x: 200, y: 130 };
const CHILD_INSET = { x: 28, y: 52 };

/**
 * Convert a survey into a durable `ArchitectureGraph`. Positions are a simple
 * deterministic grid — callers with a layout engine (the architect mode) are
 * expected to auto-layout after import. Dangling references are skipped and
 * reported in `warnings` rather than failing the import.
 */
export function surveyToArchitecture(
  survey: ArchSurvey,
  name?: string,
): SurveyImportResult {
  const warnings: string[] = [];
  const idMap = new Map<string, string>();
  const childrenOf = new Map<string, SurveyComponent[]>();

  const components = survey.components.filter((c) => {
    if (idMap.has(c.id)) {
      warnings.push(`Duplicate component id "${c.id}" — kept the first`);
      return false;
    }
    idMap.set(c.id, uid("node"));
    return true;
  });
  for (const c of components) {
    if (!c.parentId) continue;
    if (!idMap.has(c.parentId)) {
      warnings.push(`Component "${c.id}" has unknown parent "${c.parentId}" — placed at root`);
      continue;
    }
    const siblings = childrenOf.get(c.parentId) ?? [];
    siblings.push(c);
    childrenOf.set(c.parentId, siblings);
  }

  const roots = components.filter((c) => !c.parentId || !idMap.has(c.parentId));
  const nodes: ArchNode[] = [];
  const indexWithin = new Map<string, number>();
  for (const c of components) {
    const parented = Boolean(c.parentId && idMap.has(c.parentId));
    const bucket = parented ? c.parentId! : "";
    const i = indexWithin.get(bucket) ?? 0;
    indexWithin.set(bucket, i + 1);

    const hasChildren = (childrenOf.get(c.id) ?? []).length > 0;
    let kind = c.kind;
    if (hasChildren && !CONTAINER_KINDS.includes(kind)) {
      warnings.push(`Component "${c.id}" (${kind}) has children — imported as a system`);
      kind = "system";
    }
    const cols = parented ? CHILD_COLS : GRID_COLS;
    const step = parented ? CHILD_STEP : ROOT_STEP;
    const inset = parented ? CHILD_INSET : { x: 0, y: 0 };
    const childCount = (childrenOf.get(c.id) ?? []).length;
    nodes.push({
      id: idMap.get(c.id)!,
      kind,
      label: c.name,
      description: c.description,
      parentId: parented ? idMap.get(c.parentId!)! : null,
      position: {
        x: inset.x + (i % cols) * step.x,
        y: inset.y + Math.floor(i / cols) * step.y,
      },
      size: CONTAINER_KINDS.includes(kind)
        ? {
            width: Math.max(420, Math.min(childCount, CHILD_COLS) * CHILD_STEP.x + 80),
            height: Math.max(280, Math.ceil(Math.max(childCount, 1) / CHILD_COLS) * CHILD_STEP.y + 120),
          }
        : null,
      tech: c.tech,
      repoId: null,
      codeModule: c.codeModule ?? null,
      codeFile: c.codeFile ?? null,
      href: null,
      placements: {},
      layer: c.layer ?? null,
      accent: null,
    });
  }

  const edges = survey.relations.flatMap((r) => {
    const source = idMap.get(r.source);
    const target = idMap.get(r.target);
    if (!source || !target) {
      warnings.push(`Relation ${r.source} → ${r.target} references unknown components — skipped`);
      return [];
    }
    if (source === target) return [];
    return [{ id: uid("edge"), source, target, kind: r.kind, label: r.label }];
  });

  const environments: ArchEnvironment[] = [];
  for (const dep of survey.deployments) {
    const env: ArchEnvironment = { id: uid("env"), name: dep.environment, kind: dep.kind };
    environments.push(env);
    for (const p of dep.placements) {
      const nodeId = idMap.get(p.componentId);
      const node = nodeId ? nodes.find((n) => n.id === nodeId) : undefined;
      if (!node) {
        warnings.push(
          `Placement for unknown component "${p.componentId}" in ${dep.environment} — skipped`,
        );
        continue;
      }
      node.placements[env.id] = { target: p.target, runtime: p.runtime };
    }
  }
  if (environments.length === 0) environments.push(createLocalEnvironment());

  const patternNotes = survey.deployments
    .filter((d) => d.pattern || d.rationale)
    .map((d) => `${d.environment}: ${[d.pattern, d.rationale].filter(Boolean).join(" — ")}`);
  const description = [survey.source.summary, ...patternNotes, ...survey.notes]
    .filter(Boolean)
    .join("\n");

  const graphStub = { nodes } as ArchitectureGraph;
  return {
    graph: {
      id: uid("arch"),
      name: name ?? `${survey.source.kind === "iac" ? "Infra" : "Survey"}: ${survey.source.root}`,
      description,
      // react-flow requires parents before children in the node array.
      nodes: topoOrderNodes(graphStub),
      edges,
      environments,
      journeys: survey.journeys.map((j) => ({
        id: uid("journey"),
        name: j.name,
        description: j.description,
        entry: j.entry,
      })),
      facets: [],
      viewport: null,
    },
    warnings,
  };
}

/**
 * A complete, valid example survey — embedded in agent prompts as the format
 * specification and parsed in tests so the documented example can never drift
 * from the schema.
 */
export const EXAMPLE_SURVEY: ArchSurvey = {
  schemaVersion: SURVEY_SCHEMA_VERSION,
  generator: { name: "crystal-survey-agent", version: "1" },
  generatedAt: "2026-01-01T00:00:00.000Z",
  source: {
    kind: "codebase",
    root: ".",
    summary: "Order-processing platform: a storefront API in front of workers and Postgres.",
  },
  components: [
    {
      id: "platform",
      name: "Order Platform",
      kind: "system",
      description: "Everything that takes and fulfils orders",
      parentId: null,
      tech: [],
      layer: null,
      codeModule: null,
      codeFile: null,
      evidence: [],
      confidence: 1,
    },
    {
      id: "storefront-api",
      name: "storefront-api",
      kind: "service",
      description: "REST API taking orders",
      parentId: "platform",
      tech: ["node", "express"],
      layer: "entry",
      codeModule: "services/storefront",
      codeFile: null,
      evidence: ["services/storefront/package.json", "services/storefront/src/routes.ts"],
      confidence: 0.95,
    },
    {
      id: "orders-db",
      name: "orders",
      kind: "datastore",
      description: "Primary Postgres",
      parentId: "platform",
      tech: ["postgres"],
      layer: "data",
      codeModule: null,
      codeFile: null,
      evidence: ["docker-compose.yml"],
      confidence: 0.9,
    },
  ],
  relations: [
    {
      source: "storefront-api",
      target: "orders-db",
      kind: "data",
      label: "reads/writes orders",
      evidence: ["services/storefront/src/db.ts"],
    },
  ],
  deployments: [
    {
      environment: "Production",
      kind: "cloud",
      pattern: "Containerised services on ECS Fargate behind an ALB; RDS Postgres",
      rationale: "Stateless Node services with a single relational store",
      placements: [
        { componentId: "storefront-api", target: "aws / ecs", runtime: "fargate ×2" },
        { componentId: "orders-db", target: "aws / rds", runtime: "postgres 16" },
      ],
    },
  ],
  journeys: [
    {
      name: "Place order",
      description: "Checkout request through to the database",
      entry: { file: "services/storefront/src/routes.ts", symbol: "createOrder" },
    },
  ],
  notes: ["Worker queue inferred from bull import; no queue infra found in compose file."],
};

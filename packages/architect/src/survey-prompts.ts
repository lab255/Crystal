import {
  ARCH_EDGE_KINDS,
  ARCH_LAYERS,
  ARCH_NODE_KINDS,
  CRYSTAL_FILE_VERSION,
  EXAMPLE_SURVEY,
  SURVEY_SCHEMA_VERSION,
} from "@crystal/core";

export type SurveyKind = "codebase" | "iac";

/**
 * Prompt an agent run executes to survey a codebase (or IaC repo) and emit an
 * architecture survey file in the versioned interchange format. Piped to the
 * Claude CLI over stdin — never as a shell argument.
 */
export function buildSurveyPrompt(opts: {
  kind: SurveyKind;
  /** Workspace-relative root to survey ("." for the whole workspace). */
  root: string;
  /** Workspace-relative path the survey JSON must be written to. */
  outFile: string;
}): string {
  const mission =
    opts.kind === "iac"
      ? [
          `Read the infrastructure-as-code in this repository (scope: \`${opts.root}\`) — Terraform, CloudFormation/CDK, Kubernetes manifests, Helm charts, serverless configs, docker-compose, CI deploy jobs — and reconstruct the deployment architecture it encodes.`,
          "Every component and placement should come from what the IaC actually declares; use `notes` for anything you had to infer.",
        ]
      : [
          `Crawl the codebase in this repository (scope: \`${opts.root}\`) and map its architecture: the runtime components (services, frontends, gateways, datastores, queues, externals), how they talk to each other, and the main user journeys through the code.`,
          "Then suggest a deployment pattern that fits what you found (one `deployments` entry describing a sensible production topology, with per-component placements).",
        ];

  return [
    "# Architecture survey",
    "",
    ...mission,
    "",
    "## Output contract",
    "",
    `Write your findings as JSON to exactly one new file: \`${opts.outFile}\`. Create parent directories if needed. Do NOT modify any other file — this is a read-only survey plus that single artifact.`,
    "",
    "The file must be a Crystal survey envelope:",
    "",
    "```json",
    `{ "crystal": ${CRYSTAL_FILE_VERSION}, "kind": "survey", "data": { …survey payload… } }`,
    "```",
    "",
    "It is parsed strictly on import: valid JSON only (no comments, no trailing commas), and the payload must follow the schema below.",
    "",
    "## Survey payload schema",
    "",
    `- \`schemaVersion\` (required): the integer ${SURVEY_SCHEMA_VERSION}.`,
    '- `generator`: `{ "name": string, "version": string }` — identify yourself.',
    "- `generatedAt`: ISO timestamp.",
    `- \`source\`: \`{ "kind": "${opts.kind}", "root": "${opts.root}", "summary": string }\` — summary is one paragraph on what the system is.`,
    "- `components[]`: the boxes on the diagram.",
    `  - \`id\`: stable kebab-case slug, unique within this file.`,
    `  - \`name\`, \`description\`, \`kind\` — kind is one of: ${ARCH_NODE_KINDS.map((k) => `\`${k}\``).join(", ")}. Use \`system\`/\`group\` for containers that hold other components (via the child's \`parentId\`).`,
    `  - \`layer\`: one of ${ARCH_LAYERS.map((l) => `\`${l}\``).join(", ")} or null — where it sits in the request path (entry = gateways/controllers/frontends, service = business logic, data = stores/queues).`,
    "  - `tech[]`: short tags like `node`, `postgres`, `terraform`.",
    "  - `codeModule` / `codeFile`: workspace-relative module dir or file backing the component, when it maps to code in THIS repo (enables the live code overlay). Omit for external/infra-only components.",
    "  - `evidence[]`: the real file paths / config keys that prove this component exists. Every component needs at least one.",
    "  - `confidence`: 0–1.",
    `- \`relations[]\`: \`{ source, target, kind, label, evidence[] }\` between component ids — kind is one of: ${ARCH_EDGE_KINDS.map((k) => `\`${k}\``).join(", ")}.`,
    "- `deployments[]`: environments with a deployment pattern.",
    '  - `{ environment, kind: "local"|"cloud", pattern, rationale, placements[] }`.',
    "  - `pattern` is the one-line topology (e.g. \"Three-tier on ECS Fargate behind an ALB\"); `rationale` says why (or, for IaC, cites what encodes it).",
    "  - `placements[]`: `{ componentId, target, runtime }` — e.g. target `aws us-east-1 / ecs`, runtime `fargate ×3`.",
    "- `journeys[]` (codebase surveys): 2–5 key flows as `{ name, description, entry: { file, symbol } }`. The entry MUST be a real top-level symbol in a real workspace-relative file (an exported route handler, controller method wrapper, CLI entry…) — Crystal traces the call graph from it, so verify the symbol exists at the top level of that file.",
    "- `notes[]`: caveats, unknowns, and anything you inferred rather than observed.",
    "",
    "## Complete example",
    "",
    "```json",
    JSON.stringify(
      { crystal: CRYSTAL_FILE_VERSION, kind: "survey", data: EXAMPLE_SURVEY },
      null,
      2,
    ),
    "```",
    "",
    "## Method",
    "",
    "1. Establish the lay of the land first: package manifests, lockfiles, workspace configs, Dockerfiles, compose files, IaC directories, CI pipelines.",
    "2. Identify components from build/deploy boundaries, not directories alone — one deployable = one component; shared libraries only when architecturally significant.",
    "3. Trace relations from real call sites, connection strings, queue topics and env vars — record the file you saw each one in as evidence.",
    "4. Keep it to the components a new engineer needs on a whiteboard (aim for 5–20). Nest fine detail under `system` containers instead of flattening everything.",
    `5. Write the file to \`${opts.outFile}\`, re-read it to confirm it is valid JSON, and finish with a one-paragraph summary of what you found.`,
  ].join("\n");
}

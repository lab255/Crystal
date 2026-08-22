import { z } from "zod";
import { parseDocument } from "yaml";
import { classifyExternalImage, normalizeContainerImage, type ExternalServiceMeta } from "./external-services.js";

export const COMPOSE_BASENAMES = [
  "docker-compose.yml",
  "docker-compose.yaml",
  "compose.yml",
  "compose.yaml",
] as const;
export const COMPOSE_OVERRIDE_BASENAMES = ["docker-compose.override.yml", "docker-compose.override.yaml"] as const;

export function isComposePath(path: string): boolean {
  const basename = path.replace(/\\/g, "/").split("/").at(-1)?.toLowerCase() ?? "";
  return (COMPOSE_BASENAMES as readonly string[]).includes(basename)
    || (COMPOSE_OVERRIDE_BASENAMES as readonly string[]).includes(basename);
}

const StringMapSchema = z.record(z.union([z.string(), z.number(), z.boolean(), z.null()]));
const ServiceInputSchema = z.object({
  image: z.string().optional(),
  build: z.union([z.string(), z.object({ context: z.string().optional(), dockerfile: z.string().optional() }).passthrough()]).optional(),
  command: z.union([z.string(), z.array(z.string())]).optional(),
  environment: z.union([StringMapSchema, z.array(z.string())]).optional(),
  ports: z.array(z.union([z.string(), z.number(), z.object({ target: z.number().optional(), published: z.union([z.string(), z.number()]).optional() }).passthrough()])).optional(),
  volumes: z.array(z.union([z.string(), z.object({ source: z.string().optional(), target: z.string().optional(), type: z.string().optional() }).passthrough()])).optional(),
  networks: z.union([z.array(z.string()), z.record(z.unknown())]).optional(),
  depends_on: z.union([z.array(z.string()), z.record(z.unknown())]).optional(),
  profiles: z.array(z.string()).optional(),
}).passthrough();

const ComposeInputSchema = z.object({
  services: z.record(ServiceInputSchema),
  networks: z.record(z.unknown()).optional(),
  volumes: z.record(z.unknown()).optional(),
}).passthrough();

export interface ComposeFileInput { path: string; content: string }
export interface ComposeDiagnostic { path: string; message: string; severity: "warning" | "error" }
export interface ComposeService {
  name: string;
  image?: string;
  build?: string;
  command?: string[];
  environment: Record<string, string>;
  ports: string[];
  volumes: string[];
  networks: string[];
  dependsOn: string[];
  profiles: string[];
}
export interface ComposeTopology { path: string; project: string; services: ComposeService[]; networks: string[]; volumes: string[] }
export interface ComposeServiceSuggestion {
  key: string;
  project: string;
  path: string;
  service: string;
  image?: string;
  build?: string;
  tech: string;
  external: ExternalServiceMeta | null;
  ports: string[];
  volumes: string[];
  networks: string[];
  dependsOn: string[];
  profiles: string[];
}
export interface ComposeSuggestionResult {
  files: string[];
  topology: ComposeTopology[];
  suggestions: ComposeServiceSuggestion[];
  diagnostics: ComposeDiagnostic[];
}

const dirname = (p: string) => p.replace(/\\/g, "/").replace(/\/[^/]*$/, "") || ".";
const basename = (p: string) => p.replace(/\\/g, "/").split("/").at(-1)?.toLowerCase() ?? "";
const projectName = (p: string) => dirname(p).split("/").at(-1) || "workspace";

function parseOne(file: ComposeFileInput, diagnostics: ComposeDiagnostic[]): z.infer<typeof ComposeInputSchema> | null {
  try {
    const doc = parseDocument(file.content, { schema: "core", customTags: [], merge: true });
    if (doc.errors.length) throw new Error(doc.errors.map((e: { message: string }) => e.message).join("; "));
    const tagWarnings = doc.warnings.filter((warning: { code?: string }) => warning.code === "TAG_RESOLVE_FAILED");
    if (tagWarnings.length) throw new Error(tagWarnings.map((warning: { message: string }) => warning.message).join("; "));
    const parsed = ComposeInputSchema.safeParse(doc.toJS({ maxAliasCount: 100 }));
    if (!parsed.success) throw new Error(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    return parsed.data;
  } catch (error) {
    diagnostics.push({ path: file.path, severity: "error", message: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

function asStrings(value: string[] | Record<string, unknown> | undefined): string[] {
  return Array.isArray(value) ? value : value ? Object.keys(value) : [];
}
function normalizeService(name: string, input: z.infer<typeof ServiceInputSchema>): ComposeService {
  const environment = Array.isArray(input.environment)
    ? Object.fromEntries(input.environment.map((entry) => { const i = entry.indexOf("="); return i < 0 ? [entry, ""] : [entry.slice(0, i), entry.slice(i + 1)]; }))
    : Object.fromEntries(Object.entries(input.environment ?? {}).map(([k, v]) => [k, v == null ? "" : String(v)]));
  const build = typeof input.build === "string" ? input.build : input.build?.context;
  return {
    name, ...(input.image ? { image: input.image } : {}), ...(build ? { build } : {}),
    ...(input.command ? { command: Array.isArray(input.command) ? input.command : [input.command] } : {}),
    environment,
    ports: (input.ports ?? []).map((p) => typeof p === "object" ? `${p.published ?? ""}:${p.target ?? ""}` : String(p)),
    volumes: (input.volumes ?? []).map((v) => typeof v === "string" ? v : `${v.source ?? ""}:${v.target ?? ""}`),
    networks: asStrings(input.networks), dependsOn: asStrings(input.depends_on), profiles: input.profiles ?? [],
  };
}

/** Parse and normalize Compose strings. Same-directory overrides replace service fields shallowly. */
export function parseComposeFiles(files: readonly ComposeFileInput[]): ComposeSuggestionResult {
  const diagnostics: ComposeDiagnostic[] = [];
  const ordered = [...files].sort((a, b) => a.path.localeCompare(b.path));
  const parsed = new Map(ordered.map((f) => [f.path, parseOne(f, diagnostics)]));
  const bases = ordered.filter((f) => (COMPOSE_BASENAMES as readonly string[]).includes(basename(f.path)));
  const pairedBaseByDir = new Map<string, string>();
  for (const base of bases) {
    const dir = dirname(base.path);
    const current = pairedBaseByDir.get(dir);
    const dockerPrefixed = basename(base.path).startsWith("docker-compose.");
    if (!current || (dockerPrefixed && !basename(current).startsWith("docker-compose."))) pairedBaseByDir.set(dir, base.path);
  }
  const topology: ComposeTopology[] = [];
  for (const base of bases) {
    const raw = parsed.get(base.path);
    if (!raw) continue;
    const overrides = pairedBaseByDir.get(dirname(base.path)) === base.path
      ? ordered.filter((f) => dirname(f.path) === dirname(base.path) && (COMPOSE_OVERRIDE_BASENAMES as readonly string[]).includes(basename(f.path)) && parsed.get(f.path))
      : [];
    if (overrides.length && bases.filter((candidate) => dirname(candidate.path) === dirname(base.path)).length > 1) diagnostics.push({ path: base.path, severity: "warning", message: "Multiple base files share this directory; the override is paired with the docker-compose-prefixed base when possible, otherwise the lexically first base." });
    if (overrides.length > 1) diagnostics.push({ path: base.path, severity: "warning", message: "Multiple override files found; applying them in lexical order with shallow service-field replacement." });
    let services = { ...raw.services };
    let networks = { ...(raw.networks ?? {}) };
    let volumes = { ...(raw.volumes ?? {}) };
    for (const override of overrides) {
      const next = parsed.get(override.path)!;
      services = Object.fromEntries(Object.entries({ ...services, ...next.services }).map(([name, service]) => [name, services[name] ? { ...services[name], ...service } : service]));
      networks = { ...networks, ...(next.networks ?? {}) };
      volumes = { ...volumes, ...(next.volumes ?? {}) };
    }
    topology.push({ path: base.path, project: projectName(base.path), services: Object.entries(services).map(([n, s]) => normalizeService(n, s)), networks: Object.keys(networks), volumes: Object.keys(volumes) });
  }
  const suggestions = topology.flatMap((project) => project.services.map((service): ComposeServiceSuggestion => {
    const image = service.image;
    const tech = image ? normalizeContainerImage(image) || image : service.build ? `build:${service.build}` : service.name;
    return { key: `${project.path.toLowerCase()}:${service.name.toLowerCase()}`, project: project.project, path: project.path, service: service.name, ...(image ? { image } : {}), ...(service.build ? { build: service.build } : {}), tech, external: image ? classifyExternalImage(image) : null, ports: service.ports, volumes: service.volumes, networks: service.networks, dependsOn: service.dependsOn, profiles: service.profiles };
  }));
  return { files: ordered.map((f) => f.path), topology, suggestions, diagnostics };
}

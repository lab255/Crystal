import type { SystemEndpoint, SystemOverview } from "./system-overview.js";

/**
 * Surfaces — everything a product presents to the outside world, extracted
 * from the code map's syntax analysis: frontend screens (routes), reusable
 * components, their stories, and the backend's API routes and data schemas.
 * One report per workspace (`surfaces.get`), recomputed lazily with the code
 * map and invalidated by the same watcher (`codemap.changed`).
 */

export type SurfaceViewId = "screens" | "components" | "stories" | "apis" | "schemas" | "client";

/** How a screen was detected — drives the badge and the route semantics. */
export type ScreenSource = "next-app" | "next-pages" | "react-router" | "convention";

/** A navigable screen: a routed page of the frontend. */
export interface ScreenSurface {
  /** Stable id: `${source}:${route}` (routes are unique per detector). */
  id: string;
  /** URL route pattern ("/forms/:formId"); "/" for index screens. */
  route: string;
  /** Workspace-relative file declaring the screen. */
  file: string;
  line?: number;
  /** Component rendered at the route, when resolvable. */
  component?: string;
  /** File declaring that component (differs from `file` for router configs). */
  componentFile?: string;
  source: ScreenSource;
}

/** An exported React component — the reusable frontend surface. */
export interface ComponentSurface {
  name: string;
  file: string;
  line: number;
  endLine?: number;
  /** First line of the declaration — the props signature, when captured. */
  signature?: string;
  /** Files importing the declaring file (proxy for usage breadth). */
  usedBy: number;
  /** Story ids (`StorySurface.id`) exercising this component. */
  stories: string[];
  /** Screen ids rendering this component directly. */
  screens: string[];
}

/** One CSF story export. */
export interface StorySurface {
  /** Stable id: `${file}#${exportName}`. */
  id: string;
  /** CSF meta title ("Forms/Button") — falls back to the component or file name. */
  title: string;
  /** The story's export name ("Primary"). */
  name: string;
  file: string;
  line?: number;
  /** The component under test, when the CSF meta names one. */
  componentName?: string;
  /** Declaring file of that component, when resolvable through imports. */
  componentFile?: string;
}

export type SchemaKind =
  | "zod"
  | "interface"
  | "type"
  | "mongoose"
  | "prisma"
  | "drizzle"
  | "typeorm"
  | "sql";

export interface SchemaField {
  name: string;
  /** Source-level type text, best effort ("string", "z.array(...)", "Int"). */
  type?: string;
  optional?: boolean;
  /** Primary-key / id field (prisma @id, SQL PRIMARY KEY, drizzle .primaryKey()). */
  pk?: boolean;
  /**
   * Name of the schema this field points at — the ER edge. Explicit where the
   * flavour declares it (SQL REFERENCES, mongoose ref:, drizzle .references,
   * typeorm relation decorators); inferred by exact type-name match otherwise
   * (a prisma `author User` field, an interface field typed as another model).
   */
  references?: string;
}

/** A data schema: the shape of data crossing a boundary or hitting storage. */
export interface SchemaSurface {
  /** Stable id: `${file}#${name}`. */
  id: string;
  name: string;
  file: string;
  line: number;
  kind: SchemaKind;
  fields: SchemaField[];
  /** Field list hit the cap — the source has more. */
  fieldsTruncated?: boolean;
  /** Files importing the declaring file (proxy for usage breadth). */
  usedBy: number;
}

/**
 * Detected "live demo" targets — base URLs the UI can embed or open. Derived
 * from the workspace's package.json scripts (vite/next/storybook defaults);
 * null when nothing demoable was detected. The UI may let the user override.
 */
export interface DemoTargets {
  /** Dev-server base URL for screens ("http://localhost:5173"). */
  appUrl: string | null;
  /** Storybook base URL ("http://localhost:6006"). */
  storybookUrl: string | null;
}

/**
 * One outgoing HTTP call reachable from a screen's component tree, matched to
 * the served endpoint when route registration analysis finds one. The system
 * map draws these as screen → backend edges; unmatched calls (external APIs,
 * unseen routers) still render, pointed at the called path.
 */
export interface ScreenApiCall {
  /** The screen this call is reachable from (`ScreenSurface.id`). */
  screen: string;
  method: string;
  /** The path as called ("/api/bookings"). */
  path: string;
  /** Workspace-relative file of the call site. */
  file: string;
  line?: number;
  /** The served route the call matches, when one exists in this workspace. */
  endpoint?: { method: string; path: string; file: string; line?: number };
}

/**
 * The system map's join data: per-screen API reachability, computed by walking
 * each screen's import/call graph to its outgoing HTTP calls (the same
 * machinery as `codemap.apiTrace`, batched over every screen). Served by
 * `surfaces.map`; invalidated with the code map like the surfaces report.
 */
export interface SurfaceMapReport {
  calls: ScreenApiCall[];
  /** Some traces hit the traversal cap — the map may be missing edges. */
  truncated: boolean;
  generatedAt: string;
}

export interface SurfacesReport {
  screens: ScreenSurface[];
  components: ComponentSurface[];
  stories: StorySurface[];
  /** Served backend routes — same data the systems overview groups per system. */
  endpoints: SystemEndpoint[];
  schemas: SchemaSurface[];
  demo: DemoTargets;
  generatedAt: string;
}

/**
 * The product surfaces rebuilt at a git ref — the same report/overview/calls
 * triple the live system map renders, snapshotted from the ref's tree. The
 * map's ref review diffs this against the live data client-side.
 */
export interface SurfacesRefBundle {
  ref: string;
  commit: string;
  report: SurfacesReport;
  overview: SystemOverview;
  calls: ScreenApiCall[];
}

/**
 * Storybook's story-id slug: "Forms/Button" + "Primary" → "forms-button--primary".
 * Matches storybook's `toId`: the title is sanitized as-is (camelCase segments
 * stay joined — "Forms/FormBuilder" → "forms-formbuilder"), while the export
 * name goes through start-case first ("primaryCTA" → "primary-cta").
 */
export function storybookStorySlug(title: string, exportName: string): string {
  const sanitize = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
  const startCased = exportName.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  return `${sanitize(title)}--${sanitize(startCased)}`;
}

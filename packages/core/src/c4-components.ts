/**
 * C4 component tier — the abstraction the Components altitude renders.
 *
 * c4model.com defines a component as "a grouping of related functionality
 * encapsulated behind a well-defined interface", one level above code:
 * NOT a file, class or schema entity. Crystal mints components from
 * (logical system × role group): the system overview already clusters files
 * by concern (booking, auth, workflows…) and `SystemModule.groups` bands
 * each system's files by role (screens, service, data access…). A component
 * card carries the c4-style triple — name, stereotype ("Component ·
 * Service"), description — plus its *interface* (the exported symbols code
 * outside the component actually imports) and the member-file list that
 * lets marks, lenses and live-code expansion resolve it back to real code.
 *
 * Granularity contract: a container should project to roughly 5–30
 * components. Small systems stay ONE component (their dominant role); only
 * systems past MIN_ROLE_SPLIT_FILES split into per-role components. Files,
 * screens and schema entities never render as top-level members again —
 * they nest (capped) under, or roll up into, their owning component.
 *
 * `deriveC4Components` is pure and cheap (overview-sized inputs, no file
 * I/O) so clients derive it in the same memo as `deriveC4Model`.
 */

import type { C4Model } from "./c4.js";
import type { CodeRole } from "./code-roles.js";
import type { SchemaSurface, ScreenSurface } from "./surfaces.js";
import type { SystemExport, SystemOverview } from "./system-overview.js";

/** Node-id prefix of the component tier ("cmp:<container-slug>/<system-slug>[.<role>]"). */
export const COMPONENT_ID_PREFIX = "cmp:";

export function isComponentId(id: string): boolean {
  return id.startsWith(COMPONENT_ID_PREFIX);
}

/**
 * Stereotype nouns per role — the `[Component: …]` line on the card, and the
 * suffix of a split component's name ("Booking screens"). Frontend roles read
 * as React vocabulary; backend roles as tiers.
 */
export const COMPONENT_ROLE_LABELS: Record<CodeRole, string> = {
  entry: "API endpoints",
  service: "Service",
  data: "Data access",
  provider: "State & providers",
  layout: "Screens",
  component: "UI components",
  query: "API client",
  other: "Modules",
};

/** One component card of the C4 Components altitude. */
export interface C4Component {
  /** "cmp:<container-slug>/<system-slug>" — "." + role appended when the system splits. */
  id: string;
  containerId: string;
  /** Canonical `sys:` id the component was minted from. */
  systemId: string;
  role: CodeRole;
  /** Display name — the system name, or "<System> <role label>" when split. */
  name: string;
  /** Stereotype noun for the type line, e.g. "Service", "UI components". */
  stereotype: string;
  /** Deterministic one-liner: what it does / exposes, from real facts only. */
  description: string;
  /** Dominant intent concept inherited from the system, when tag-driven. */
  concern: string | null;
  /** Member files (workspace-relative), capped — see filesTruncated. */
  files: string[];
  fileCount: number;
  filesTruncated?: boolean;
  /** The well-defined interface: exports consumed from outside, top first (capped). */
  interface: SystemExport[];
  /** Total externally-consumed exports beyond the cap. */
  interfaceTotal: number;
  /** Top libraries the component leans on. */
  tech: string[];
  screenCount: number;
  endpointCount: number;
  /** Schema entities owned by member files (0 when schemas not provided). */
  entityCount: number;
}

/** An aggregated edge between two components (or a component and a neighbor). */
export interface C4ComponentEdge {
  source: string;
  target: string;
  /** Import statements (or matched API calls) crossing the boundary. */
  weight: number;
  kind: "imports" | "api";
  /** Most-imported symbol names along the edge (capped). */
  symbols?: string[];
}

export interface C4ComponentModel {
  /** Components per container id, projection order (band order, then size). */
  byContainer: Record<string, C4Component[]>;
  /** Workspace-relative file → owning component id (capped members only). */
  componentOfFile: Record<string, string>;
  /** Canonical `sys:` id → its primary component (rollup target for sys-id marks/links). */
  componentOfSystem: Record<string, string>;
  /** Component-to-component edges across the whole model (both intra- and cross-container). */
  edges: C4ComponentEdge[];
}

export interface C4ComponentsInput {
  model: C4Model;
  overview: SystemOverview;
  screens?: readonly ScreenSurface[] | null;
  schemas?: readonly SchemaSurface[] | null;
}

/** A system splits into per-role components only past this many files. */
export const MIN_ROLE_SPLIT_FILES = 12;
/** A role group below this many files folds into the system's primary component. */
export const MIN_GROUP_FILES = 3;
/** Interface symbols carried per component card. */
export const COMPONENT_INTERFACE_CAP = 6;
/** Member files carried per component (beyond it, only fileCount is known). */
export const COMPONENT_FILE_CAP = 200;

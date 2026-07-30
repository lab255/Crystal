import {
  canonicalSystemIds,
  type SystemOverview,
  type SystemRole,
} from "@crystal/core";

/**
 * The semantic body of a `sys:` card on the architecture canvas — the facts
 * the retired systems view rendered on every card (the consumed export
 * surface with consumer counts, and the systems/externals/libraries the
 * system leans on), restored onto the unified canvas.
 *
 * Everything here is a plain value record joined to canvas nodes by canonical
 * id: react-flow node data must stay structured-clonable (scene builds can
 * run in web workers), so this module derives data only — never functions.
 */

/** Export rows shown on a card (the old view's `exportsShown` cap). */
export const SYSTEM_CARD_EXPORTS_MAX = 4;
/** Names kept for the Consumes footer (the card renders a slice + "+N"). */
export const SYSTEM_CARD_CONSUMES_MAX = 6;
/** Card width of the retired systems view — the reserve for card-only nodes. */
export const SYSTEM_CARD_W = 252;

export interface SystemCardExport {
  name: string;
  /** Distinct outside files importing it. */
  consumers: number;
  /** React component export — gets the component glyph. */
  component: boolean;
}

export interface SystemCardFacts {
  role: SystemRole;
  fileCount: number;
  componentCount: number;
  endpointCount: number;
  /** Externally-consumed exports, most-consumed first, capped. */
  exports: SystemCardExport[];
  /** Consumed exports beyond the cap (never negative). */
  exportsMore: number;
  /** Names of the systems this one imports from, capped. */
  consumes: string[];
  consumesMore: number;
  /** External service names, capped. */
  externals: string[];
  externalsMore: number;
  /** Library package names, capped. */
  libraries: string[];
  librariesMore: number;
}

const capped = <T,>(list: readonly T[], max: number): { head: T[]; more: number } => ({
  head: list.slice(0, max),
  more: Math.max(0, list.length - max),
});

/**
 * Join `SystemModule` facts to canvas nodes: canonical node id → the card
 * body. Consumes lists the *names* of outbound link targets, exactly as the
 * old card did.
 */
export function buildSystemCardFacts(overview: SystemOverview): Map<string, SystemCardFacts> {
  const idOfRaw = canonicalSystemIds(overview.systems);
  const nameOf = new Map(overview.systems.map((s) => [s.id, s.name]));
  const consumesOf = new Map<string, string[]>();
  for (const l of overview.links) {
    const list = consumesOf.get(l.source) ?? [];
    list.push(nameOf.get(l.target) ?? l.target);
    consumesOf.set(l.source, list);
  }
  const out = new Map<string, SystemCardFacts>();
  for (const s of overview.systems) {
    const exports = capped(s.exports, SYSTEM_CARD_EXPORTS_MAX);
    const consumes = capped(consumesOf.get(s.id) ?? [], SYSTEM_CARD_CONSUMES_MAX);
    const externals = capped(s.externals, 4);
    const libraries = capped(s.libraries, 4);
    out.set(idOfRaw.get(s.id) ?? s.id, {
      role: s.role,
      fileCount: s.fileCount,
      componentCount: s.componentCount,
      endpointCount: s.endpoints.length,
      exports: exports.head.map((e) => ({
        name: e.name,
        consumers: e.consumers,
        component: e.kind === "component",
      })),
      exportsMore: exports.more,
      consumes: consumes.head,
      consumesMore: consumes.more,
      externals: externals.head.map((x) => x.name),
      externalsMore: externals.more,
      libraries: libraries.head.map((l) => l.pkg),
      librariesMore: libraries.more,
    });
  }
  return out;
}

/* ---- reserved footprint ---- */

// The overview body renders at the slot-scaled type of `LeafNode` (label
// ≈18px at the card width); these allowances are measured against that.
const CARD_BASE_H = 96; // header + role/count line + padding
const CARD_DESC_H = 32; // two clamped description lines
const CARD_SECTION_H = 18; // section heading
const CARD_ROW_H = 17; // one export row
const CARD_CONSUMES_H = 34; // wrapped consumes text
const CARD_FOOT_H = 30; // tech badges / code-link badge allowance

/**
 * Height the semantic card body needs. Reserved-LOD-footprint convention
 * (`layout.ts` `reserve`): a system node is laid out at the larger of its
 * live-code expansion footprint and this card size, so the exports/consumes
 * sections never overflow the box and zooming never reflows the diagram.
 */
export function systemCardSlot(facts: SystemCardFacts): { width: number; height: number } {
  let h = CARD_BASE_H + CARD_DESC_H;
  const shown = Math.min(facts.exports.length, SYSTEM_CARD_EXPORTS_MAX);
  if (shown > 0) h += CARD_SECTION_H + shown * CARD_ROW_H;
  if (facts.consumes.length > 0 || facts.externals.length > 0 || facts.libraries.length > 0)
    h += CARD_SECTION_H + CARD_CONSUMES_H;
  return { width: SYSTEM_CARD_W, height: h + CARD_FOOT_H };
}

/** Elementwise max of two footprints (module expansion vs semantic card). */
export function maxSlot(
  a: { width: number; height: number } | undefined,
  b: { width: number; height: number },
): { width: number; height: number } {
  if (!a) return b;
  return { width: Math.max(a.width, b.width), height: Math.max(a.height, b.height) };
}

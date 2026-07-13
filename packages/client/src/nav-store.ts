import { createStore, type StoreApi } from "zustand/vanilla";
import {
  applyDeepLink,
  type ArchitectLink,
  type CodeLink,
  type CrystalModeId,
  type DeepLink,
  type OrchestrateLink,
} from "@crystal/core";

/**
 * Section patches use `null` to clear a field (matching the `string | null`
 * convention of the view components); omitted fields are left alone.
 */
type SectionPatch<T> = { [K in keyof T]?: T[K] | null };

export interface NavPatch {
  ws?: string | null;
  mode?: CrystalModeId;
  architect?: SectionPatch<ArchitectLink>;
  orchestrate?: SectionPatch<OrchestrateLink>;
  code?: SectionPatch<CodeLink>;
}

/**
 * Navigational state for the whole IDE — which mode, workspace and per-mode
 * view/selection the user is looking at. This is the state the URL hash
 * serializes (see `@crystal/core` deeplink.ts); the SDK shell keeps the two
 * in sync. It holds *every* mode's state so switching modes restores views,
 * while the URL only shows the active mode's slice.
 */
export interface NavState {
  link: DeepLink;
  /** Merge a patch (per-mode sections merge field-by-field; `null` clears a field). */
  update(patch: NavPatch): void;
  /**
   * Apply a parsed URL (back/forward): mode/ws win when present, and the
   * incoming subview's URL-expressible fields replace the stored ones —
   * see `applyDeepLink` in @crystal/core. State the URL never carried
   * (other subviews' drills, selections, panels) survives.
   */
  apply(next: DeepLink): void;
}

export type NavStore = StoreApi<NavState>;

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  const ak = Object.keys(a as object);
  const bk = Object.keys(b as object);
  if (ak.length !== bk.length) return false;
  return ak.every((k) =>
    deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}

function mergeSection<T extends object>(
  current: T | undefined,
  patch: SectionPatch<T> | undefined,
): T | undefined {
  if (!patch) return current;
  const next: Record<string, unknown> = { ...(current ?? {}) };
  for (const key of Object.keys(patch)) {
    const value = (patch as Record<string, unknown>)[key];
    if (value === null || value === undefined || value === false) delete next[key];
    else next[key] = value;
  }
  return Object.keys(next).length > 0 ? (next as T) : undefined;
}

export function createNavStore(initial: DeepLink = {}): NavStore {
  return createStore<NavState>((set, get) => ({
    link: initial,

    update(patch) {
      const cur = get().link;
      const link: DeepLink = { ...cur };
      if (patch.ws !== undefined) {
        if (patch.ws === null) delete link.ws;
        else link.ws = patch.ws;
      }
      if (patch.mode !== undefined) link.mode = patch.mode;
      const architect = mergeSection(cur.architect, patch.architect);
      if (architect) link.architect = architect;
      else if (patch.architect) delete link.architect;
      const orchestrate = mergeSection(cur.orchestrate, patch.orchestrate);
      if (orchestrate) link.orchestrate = orchestrate;
      else if (patch.orchestrate) delete link.orchestrate;
      const code = mergeSection(cur.code, patch.code);
      if (code) link.code = code;
      else if (patch.code) delete link.code;
      if (!deepEqual(link, cur)) set({ link });
    },

    apply(next) {
      const cur = get().link;
      const link = applyDeepLink(cur, next);
      if (!deepEqual(link, cur)) set({ link });
    },
  }));
}

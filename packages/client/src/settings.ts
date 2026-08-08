/**
 * App-level preferences — machine-local, UI-only concerns (theme, composer
 * keymap, nav layout). Persisted to localStorage as one JSON blob; nothing
 * here belongs to a workspace or travels over the bridge. Module-singleton
 * store, same shape as desktop-update.ts.
 */
import type * as React from "react";
import { createStore } from "zustand/vanilla";
import { useStore } from "zustand";

const SETTINGS_KEY = "crystal.settings";

export type ThemePreference = "light" | "dark" | "system";

/**
 * How composers dispatch: "mod-enter" = Ctrl/Cmd+Enter sends and Enter makes
 * a newline; "enter" = plain Enter sends, Shift/Alt+Enter makes a newline.
 * Ctrl/Cmd+Enter always sends in either mode — muscle memory must never
 * type a newline into one composer and dispatch in another.
 */
export type EnterBehavior = "mod-enter" | "enter";

export interface AppSettings {
  theme: ThemePreference;
  enterToSend: EnterBehavior;
  /** Slack-style workspace rail: icon-only (false) or with names (true). */
  railExpanded: boolean;
  /** Agent questions and recoverable failures that need the operator. */
  notifyAttention: boolean;
  /** Agent runs that settle and are ready to review. */
  notifyRunsSettled: boolean;
  /** Workflows automatically paused by their budget or stall guard. */
  notifyWorkflowPaused: boolean;
  /** Project-nav section order (mode ids); missing modes append in default order. */
  navOrder: string[];
}

export interface SettingsState extends AppSettings {
  set: (patch: Partial<AppSettings>) => void;
}

const DEFAULTS: AppSettings = {
  theme: "system",
  enterToSend: "mod-enter",
  railExpanded: false,
  notifyAttention: true,
  notifyRunsSettled: true,
  notifyWorkflowPaused: true,
  navOrder: [],
};

function load(): AppSettings {
  if (typeof localStorage === "undefined") return DEFAULTS;
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    return {
      theme: parsed.theme === "light" || parsed.theme === "dark" ? parsed.theme : "system",
      enterToSend: parsed.enterToSend === "enter" ? "enter" : "mod-enter",
      railExpanded: parsed.railExpanded === true,
      notifyAttention: parsed.notifyAttention !== false,
      notifyRunsSettled: parsed.notifyRunsSettled !== false,
      notifyWorkflowPaused: parsed.notifyWorkflowPaused !== false,
      navOrder: Array.isArray(parsed.navOrder)
        ? parsed.navOrder.filter((m): m is string => typeof m === "string")
        : [],
    };
  } catch {
    return DEFAULTS;
  }
}

export const settingsStore = createStore<SettingsState>((set, get) => ({
  ...load(),
  set: (patch) => {
    set(patch);
    const {
      theme,
      enterToSend,
      railExpanded,
      notifyAttention,
      notifyRunsSettled,
      notifyWorkflowPaused,
      navOrder,
    } = get();
    try {
      localStorage.setItem(
        SETTINGS_KEY,
        JSON.stringify({
          theme,
          enterToSend,
          railExpanded,
          notifyAttention,
          notifyRunsSettled,
          notifyWorkflowPaused,
          navOrder,
        } satisfies AppSettings),
      );
    } catch {
      /* storage blocked — the session keeps its settings anyway */
    }
    if (patch.theme !== undefined) applyTheme(patch.theme);
  },
}));

export function useSettings<T>(selector: (s: SettingsState) => T): T {
  return useStore(settingsStore, selector);
}

/**
 * Stamp the preference onto <html>. Tokens are `light-dark()` pairs resolved
 * by `color-scheme` (see packages/ui/src/styles.css): "system" removes the
 * override so the OS preference decides.
 */
export function applyTheme(pref: ThemePreference): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (pref === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", pref);
}

/** Call once at shell mount: applies the persisted theme before first paint. */
export function initTheme(): void {
  applyTheme(settingsStore.getState().theme);
}

/**
 * The one composer keymap. Returns what a keydown should do — "send",
 * "newline" (caller inserts it / lets the textarea default run), or null
 * (not an Enter press). Every dispatch/compose surface routes through this
 * so the keys mean the same thing everywhere.
 */
export function enterKeyAction(
  e: Pick<React.KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey">,
  behavior: EnterBehavior,
): "send" | "newline" | null {
  if (e.key !== "Enter") return null;
  if (e.ctrlKey || e.metaKey) return "send";
  if (e.shiftKey || e.altKey) return "newline";
  return behavior === "enter" ? "send" : "newline";
}

/**
 * Keydown handler for a dispatching textarea: sends per the user's Enter
 * preference. `onSend` fires with the event already defaulted-prevented.
 */
export function useComposerKeydown(
  onSend: () => void,
): (e: React.KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>) => void {
  const behavior = useSettings((s) => s.enterToSend);
  return (e) => {
    if (enterKeyAction(e, behavior) === "send") {
      e.preventDefault();
      onSend();
    }
  };
}

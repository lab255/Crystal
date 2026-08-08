/**
 * Desktop auto-update. On launch inside the Tauri shell, ask GitHub Releases
 * (via the `latest.json` endpoint configured in tauri.conf.json) whether a
 * newer build exists; if so, download it, verify its minisign signature against
 * the pubkey baked into the app, apply it, and relaunch into the new version.
 *
 * Everywhere else — the browser / remote web console — this is a no-op: the
 * Tauri updater plugins aren't present, so the dynamic imports below never load
 * (Vite splits them into a chunk the browser build never fetches). The whole
 * thing is best-effort: offline, no release yet, or a signature mismatch just
 * leaves the running app untouched — an update never blocks or breaks startup.
 *
 * Progress is observable: the footer's version badge subscribes to
 * `desktopUpdateStore` and doubles as the explicit "check for updates" action
 * (`checkForDesktopUpdateNow`), so mid-session checks are user-initiated —
 * on Windows the installer exits the app, which is nothing to spring on
 * someone mid-edit.
 */
import { createStore } from "zustand/vanilla";
import { useStore } from "zustand";
import { isDesktop } from "./desktop-window.js";

export type DesktopUpdatePhase =
  | "idle"
  | "checking"
  | "downloading"
  | "restarting"
  | "uptodate"
  | "error";

export interface DesktopUpdateState {
  /** False outside the Tauri webview — the badge renders as plain text. */
  supported: boolean;
  phase: DesktopUpdatePhase;
  /** The version being downloaded/installed, when known. */
  version: string | null;
  error: string | null;
}

export const desktopUpdateStore = createStore<DesktopUpdateState>(() => ({
  supported: isDesktop(),
  phase: "idle",
  version: null,
  error: null,
}));

export function useDesktopUpdate<T>(selector: (s: DesktopUpdateState) => T): T {
  return useStore(desktopUpdateStore, selector);
}

let checkedAtLaunch = false;
let inFlight = false;

async function runUpdateCheck(): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  const set = desktopUpdateStore.setState;
  set({ phase: "checking", error: null });
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check();
    if (!update) {
      set({ phase: "uptodate", version: null });
      return;
    }
    console.info(`[crystal] updating ${update.currentVersion} → ${update.version}…`);
    set({ phase: "downloading", version: update.version });
    // Verifies the signature, swaps the app, then restarts. On Windows the
    // installer takes over and the process exits on its own.
    await update.downloadAndInstall();
    set({ phase: "restarting" });
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
  } catch (err) {
    console.warn("[crystal] update check skipped:", err);
    set({ phase: "error", error: err instanceof Error ? err.message : String(err) });
  } finally {
    inFlight = false;
  }
}

/**
 * Launch-time check — once per app session. Done at startup, before any
 * workspace work, so the relaunch is the least disruptive.
 */
export async function checkForDesktopUpdate(): Promise<void> {
  if (checkedAtLaunch || !isDesktop()) return;
  checkedAtLaunch = true;
  await runUpdateCheck();
}

/** Explicit "check for updates" — the footer badge's click action. */
export async function checkForDesktopUpdateNow(): Promise<void> {
  if (!isDesktop()) return;
  await runUpdateCheck();
}

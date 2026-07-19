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
 */

/** True only inside the Tauri webview (same probe as the transport selector). */
function inTauriWebview(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as unknown as Record<string, unknown>;
  return "__TAURI_INTERNALS__" in w || "isTauri" in w || "__TAURI__" in w;
}

let checked = false;

export async function checkForDesktopUpdate(): Promise<void> {
  // Once per app session — the launch check is enough; re-checks belong behind
  // an explicit "Check for updates" action, not another mount.
  if (checked || !inTauriWebview()) return;
  checked = true;
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check();
    if (!update) return;
    console.info(`[crystal] updating ${update.currentVersion} → ${update.version}…`);
    // Verifies the signature, swaps the .app, then restarts. Done at launch,
    // before any workspace work, so the relaunch is the least disruptive.
    await update.downloadAndInstall();
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
  } catch (err) {
    console.warn("[crystal] update check skipped:", err);
  }
}

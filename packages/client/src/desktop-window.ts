export type DesktopPlatform = "macos" | "windows" | "linux" | null;

/** True only inside a Tauri desktop WebView. */
export function isDesktop(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as unknown as Record<string, unknown>;
  return "__TAURI_INTERNALS__" in w || "isTauri" in w || "__TAURI__" in w;
}

/**
 * Host OS for the Tauri desktop shell. Browser visits deliberately return
 * null, even though their user agent also exposes an operating system.
 */
export function desktopPlatform(): DesktopPlatform {
  if (!isDesktop() || typeof navigator === "undefined") return null;
  const platform = `${navigator.platform ?? ""} ${navigator.userAgent ?? ""}`.toLowerCase();
  if (platform.includes("mac")) return "macos";
  if (platform.includes("win")) return "windows";
  if (platform.includes("linux") || platform.includes("x11")) return "linux";
  return null;
}

/**
 * Open a second Crystal window on the current view. In the desktop shell this
 * asks Tauri for a real OS window (same webview bundle, own nav state); in a
 * browser it's a plain `window.open`. The bridge is multi-client by design —
 * every window is just another socket, so no coordination is needed here.
 */
export async function openNewWindow(url?: string): Promise<void> {
  if (typeof window === "undefined") return;
  const href = url ?? window.location.href;
  if (isDesktop()) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("new_window", { url: href });
      return;
    } catch {
      /* older sidecar without the command — fall through to window.open */
    }
  }
  window.open(href, "_blank", "noopener");
}

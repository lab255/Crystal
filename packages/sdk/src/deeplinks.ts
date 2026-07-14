import { useEffect } from "react";
import { deepLinkNavIdentity, formatDeepLink, parseDeepLink } from "@crystal/core";
import { useCrystal } from "@crystal/client";
import type { CrystalMode } from "./modes.js";

/**
 * Two-way sync between the nav store and the URL hash.
 *
 * - On load (and on back/forward/manual hash edits) the hash is parsed into
 *   the nav store; a linked workspace id is activated once the workspace list
 *   arrives (one-shot — a stale id from another machine is simply ignored).
 * - Nav-store changes write the canonical hash back: pushState when the
 *   navigation identity changes (mode, subview, drill level, open document —
 *   back-button-worthy; see `deepLinkNavIdentity`), replaceState for
 *   selection/panel tweaks, so history isn't spammed by every click.
 * - The URL always mirrors the *active* workspace; the store keeps every
 *   mode's view state so mode switches restore where you were.
 */
export function useDeepLinks(enabled: boolean, defaultMode: CrystalMode): void {
  const { navStore, workspacesStore } = useCrystal();

  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;

    // Workspace id from an applied link, waiting for the workspace list.
    let pendingWs: string | null = null;

    const tryActivateWs = () => {
      if (!pendingWs) return;
      const { workspaces, activeId, setActive } = workspacesStore.getState();
      if (workspaces.some((w) => w.id === pendingWs)) {
        if (activeId !== pendingWs) setActive(pendingWs);
        pendingWs = null;
      } else if (workspaces.length > 0) {
        // List is loaded and the linked workspace isn't open here — give up
        // and let the active-workspace mirror rewrite the URL.
        pendingWs = null;
      }
    };

    const applyFromUrl = () => {
      const raw = window.location.hash;
      const parsed = parseDeepLink(raw);
      // A non-empty hash that parsed to no mode is a dead link (unknown mode
      // name) — fall back to the default view and normalize the address bar
      // so the broken hash doesn't linger as if it meant something.
      const unknown = raw.length > 2 && !parsed.mode;
      pendingWs =
        parsed.ws && parsed.ws !== workspacesStore.getState().activeId ? parsed.ws : null;
      if (!parsed.mode) parsed.mode = unknown ? defaultMode : (navStore.getState().link.mode ?? defaultMode);
      navStore.getState().apply(parsed);
      tryActivateWs();
      if (unknown) writeUrl(true);
    };

    const writeUrl = (replaceOnly = false) => {
      const link = navStore.getState().link;
      const hash = formatDeepLink(link);
      if (!hash || hash === window.location.hash) return;
      const url = `${window.location.pathname}${window.location.search}${hash}`;
      const samePlace =
        replaceOnly ||
        deepLinkNavIdentity(parseDeepLink(window.location.hash)) === deepLinkNavIdentity(link);
      if (samePlace) history.replaceState(null, "", url);
      else history.pushState(null, "", url);
    };

    if (window.location.hash.length > 1) applyFromUrl();
    if (!navStore.getState().link.mode) navStore.getState().update({ mode: defaultMode });
    // Normalize the address bar in place so "copy link" works from the start —
    // never push here, or the fresh session starts with a dead back entry.
    writeUrl(true);

    const unsubNav = navStore.subscribe(() => writeUrl());
    const unsubWs = workspacesStore.subscribe(() => {
      tryActivateWs();
      const { activeId } = workspacesStore.getState();
      if (!pendingWs && activeId && activeId !== navStore.getState().link.ws) {
        navStore.getState().update({ ws: activeId });
      }
    });
    // pushState navigation surfaces as popstate; manual `#/...` edits as hashchange.
    window.addEventListener("popstate", applyFromUrl);
    window.addEventListener("hashchange", applyFromUrl);
    return () => {
      unsubNav();
      unsubWs();
      window.removeEventListener("popstate", applyFromUrl);
      window.removeEventListener("hashchange", applyFromUrl);
    };
  }, [enabled, defaultMode, navStore, workspacesStore]);
}

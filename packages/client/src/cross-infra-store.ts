import { createStore, type StoreApi } from "zustand/vanilla";
import type { CrossInfraMap, CrossInfraOverlay, IdentityLink } from "@crystal/core";
import type { BridgeClient } from "./bridge-client.js";

const DATA_REFRESH_DEBOUNCE_MS = 300;
const OVERLAY_SAVE_DEBOUNCE_MS = 300;
const OVERLAY_SAVE_RETRY_MS = 1_000;

export interface CrossInfraState {
  map: CrossInfraMap | null;
  overlay: CrossInfraOverlay | null;
  loading: boolean;
  error: string | null;
  dirty: boolean;
  ensure(): Promise<void>;
  refreshMap(): Promise<void>;
  refreshOverlay(): Promise<void>;
  setPin(sceneId: string, position: { x: number; y: number } | null): void;
  setEnvSelection(ws: string, envId: string | null): void;
  clearPins(): void;
  addIdentityLink(members: IdentityLink["members"], label?: string): string | undefined;
  removeIdentityLink(id: string): void;
  flush(): Promise<void>;
}

export type CrossInfraStore = StoreApi<CrossInfraState>;

export function createCrossInfraStore(client: BridgeClient): CrossInfraStore {
  let loadPromise: Promise<void> | null = null;
  let dataTimer: ReturnType<typeof setTimeout> | null = null;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let savePromise: Promise<void> | null = null;
  let retryUsed = false;
  let mapEpoch = 0;
  let overlayEpoch = 0;

  const store = createStore<CrossInfraState>((set, get) => {
    const scheduleSave = (delay = OVERLAY_SAVE_DEBOUNCE_MS): void => {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        saveTimer = null;
        void persistOverlay().catch(() => {});
      }, delay);
    };

    const persistOverlay = async (): Promise<void> => {
      if (savePromise) return savePromise;
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      const overlay = get().overlay;
      if (!overlay) return;
      savePromise = client
        .request("infra.crossOverlay.save", { overlay })
        .then(({ overlay: saved }) => {
          // A newer optimistic edit owns the current value.
          if (get().overlay === overlay) {
            retryUsed = false;
            set({ overlay: saved, error: null, dirty: false });
          }
        })
        .catch((err: unknown) => {
          set({ error: err instanceof Error ? err.message : String(err), dirty: true });
          // Retry one rejected snapshot after a short delay. A second failure
          // stays dirty and the next mutation re-arms the normal save path.
          if (get().overlay === overlay && !retryUsed) {
            retryUsed = true;
            scheduleSave(OVERLAY_SAVE_RETRY_MS);
          }
          throw err;
        })
        .finally(() => {
          savePromise = null;
          // An edit made during the request schedules its own snapshot.
          if (get().overlay !== overlay && !saveTimer) scheduleSave();
        });
      return savePromise;
    };

    const updateOverlay = (change: (overlay: CrossInfraOverlay) => CrossInfraOverlay): void => {
      const overlay = get().overlay;
      if (!overlay) return;
      retryUsed = false;
      set({ overlay: change(overlay), error: null, dirty: true });
      scheduleSave();
    };

    return {
      map: null,
      overlay: null,
      loading: false,
      error: null,
      dirty: false,

      async ensure() {
        if (get().map && get().overlay) return;
        if (loadPromise) return loadPromise;
        set({ loading: true, error: null });
        loadPromise = Promise.all([get().refreshMap(), get().refreshOverlay()])
          .then(() => {})
          .finally(() => {
            loadPromise = null;
            set({ loading: false });
          });
        return loadPromise;
      },

      async refreshMap() {
        const epoch = ++mapEpoch;
        try {
          const map = await client.request("infra.cross", {});
          if (epoch === mapEpoch) set({ map, error: null });
        } catch (err) {
          if (epoch === mapEpoch)
            set({ error: err instanceof Error ? err.message : String(err) });
        }
      },

      async refreshOverlay() {
        const epoch = ++overlayEpoch;
        try {
          const { overlay } = await client.request("infra.crossOverlay.get", {});
          if (epoch !== overlayEpoch || saveTimer || savePromise || get().dirty) return;
          set({ overlay, error: null, dirty: false });
        } catch (err) {
          if (epoch === overlayEpoch)
            set({ error: err instanceof Error ? err.message : String(err) });
        }
      },

      setPin(sceneId, position) {
        updateOverlay((overlay) => {
          const pins = { ...overlay.pins };
          if (position) pins[sceneId] = position;
          else delete pins[sceneId];
          return { ...overlay, pins, updatedAt: new Date().toISOString() };
        });
      },

      setEnvSelection(ws, envId) {
        updateOverlay((overlay) => ({
          ...overlay,
          envSelection: { ...overlay.envSelection, [ws]: envId },
          updatedAt: new Date().toISOString(),
        }));
      },

      clearPins() {
        updateOverlay((overlay) => ({
          ...overlay,
          pins: {},
          updatedAt: new Date().toISOString(),
        }));
      },

      addIdentityLink(members, label) {
        const overlay = get().overlay;
        if (!overlay) return undefined;
        const memberSet = (items: IdentityLink["members"]) =>
          JSON.stringify([...new Set(items.map((member) => JSON.stringify([member.ws, member.key])))].sort());
        const signature = memberSet(members);
        const existing = overlay.identityLinks.find((link) => memberSet(link.members) === signature);
        if (existing) return existing.id;
        const id = crypto.randomUUID();
        updateOverlay((current) => ({
          ...current,
          identityLinks: [...current.identityLinks, {
            id,
            ...(label?.trim() ? { label: label.trim() } : {}),
            members: members.map((member) => ({ ...member })),
          }],
          updatedAt: new Date().toISOString(),
        }));
        return id;
      },

      removeIdentityLink(id) {
        updateOverlay((overlay) => {
          const pins = { ...overlay.pins };
          delete pins[`idlink:${id}`];
          return {
            ...overlay,
            pins,
            identityLinks: overlay.identityLinks.filter((link) => link.id !== id),
            updatedAt: new Date().toISOString(),
          };
        });
      },

      async flush() {
        await persistOverlay();
      },
    };
  });

  client.events.on("infra.crossChanged", ({ reason }) => {
    if (reason === "layout") {
      if (!saveTimer && !savePromise && !store.getState().dirty)
        void store.getState().refreshOverlay();
      return;
    }
    if (dataTimer) clearTimeout(dataTimer);
    dataTimer = setTimeout(() => {
      dataTimer = null;
      void store.getState().refreshMap();
    }, DATA_REFRESH_DEBOUNCE_MS);
  });

  return store;
}

const STORES = new WeakMap<BridgeClient, CrossInfraStore>();

/** One cross-infrastructure store per bridge connection. */
export function crossInfraStoreFor(client: BridgeClient): CrossInfraStore {
  let store = STORES.get(client);
  if (!store) {
    store = createCrossInfraStore(client);
    STORES.set(client, store);
  }
  return store;
}

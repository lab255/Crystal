import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // Fail loudly if 5173 is taken rather than drifting to 5174 — the app
    // derives its bridge URL from this origin, and a silent port change served
    // a stale/foreign page on 5173.
    port: 5173,
    strictPort: true,
    proxy: {
      // In dev the bridge (WS RPC) runs on its own port; the app dials
      // ws://<page-origin>/crystal, so forward that path to the bridge.
      // Keep in sync with DEFAULT_BRIDGE_PORT (@crystal/core).
      "/crystal": {
        target: "ws://127.0.0.1:4517",
        ws: true,
        changeOrigin: true,
      },
    },
  },
});

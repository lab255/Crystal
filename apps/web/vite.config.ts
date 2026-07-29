import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// The repo root package.json owns the release version (scripts/release.mjs
// bumps it); baking it in here is what keeps the footer badge honest — the
// desktop build bundles this same web build, so one define covers both.
const rootPkg = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { version: string };

// Overridable so an isolated verification stack (own bridge + own web port)
// can run beside the real dev stack without touching this file.
const webPort = Number(process.env.CRYSTAL_WEB_PORT ?? 5173);
const bridgePort = Number(process.env.CRYSTAL_BRIDGE_PORT ?? 4517);

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    __CRYSTAL_VERSION__: JSON.stringify(rootPkg.version),
  },
  server: {
    // Fail loudly if the port is taken rather than drifting to the next one —
    // the app derives its bridge URL from this origin, and a silent port
    // change served a stale/foreign page on 5173.
    port: webPort,
    strictPort: true,
    proxy: {
      // In dev the bridge (WS RPC) runs on its own port; the app dials
      // ws://<page-origin>/crystal, so forward that path to the bridge.
      // Keep in sync with DEFAULT_BRIDGE_PORT (@crystal/core).
      "/crystal": {
        target: `ws://127.0.0.1:${bridgePort}`,
        ws: true,
        changeOrigin: true,
      },
    },
  },
});

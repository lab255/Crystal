import { defineConfig } from "tsup";

// Single-file CJS bundle used for the desktop sidecar (fed into Node SEA).
export default defineConfig({
  entry: { "crystal-server": "src/index.ts" },
  format: ["cjs"],
  platform: "node",
  target: "node20",
  bundle: true,
  sourcemap: false,
  clean: true,
  noExternal: [/.*/],
  // ws optional native accelerators — absent at runtime, ws falls back to JS.
  external: ["bufferutil", "utf-8-validate"],
});

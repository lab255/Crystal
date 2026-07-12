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
  external: [
    // ws optional native accelerators — absent at runtime, ws falls back to JS.
    "bufferutil",
    "utf-8-validate",
    // node-pty is a native addon and cannot be embedded in a Node SEA. It's
    // shipped on disk next to the sidecar (staged by build-sidecar.mjs) and
    // loaded via the require rebind in `banner` below.
    /^@lydell\/node-pty/,
  ],
  // Inside a SEA, the ambient require() resolves built-ins only. Rebind it to
  // a createRequire anchored at the on-disk module base (the Tauri resource
  // dir, passed as CRYSTAL_SIDECAR_MODULE_BASE; else next to the executable)
  // so the externalized node-pty resolves from a real node_modules.
  banner: {
    js: [
      "const { createRequire: __cr } = require('node:module');",
      "const __p = require('node:path');",
      "const __base = process.env.CRYSTAL_SIDECAR_MODULE_BASE || __p.dirname(process.execPath);",
      "require = __cr(__p.join(__base, 'sea-require-anchor.cjs'));",
    ].join("\n"),
  },
});

import { defineConfig } from "tsup";
import { crystalTsup } from "../../tsup.base.mjs";

// The sdk is the only package published standalone to npm — its workspace
// siblings aren't published, so they must be bundled into its output rather
// than left as external `@crystal/*` imports.
export default defineConfig(crystalTsup({ noExternal: [/^@crystal\//] }));

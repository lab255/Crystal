/** Shared ambient declarations for the whole workspace (wired in tsconfig.base.json). */

declare module "*?worker" {
  const WorkerFactory: new () => Worker;
  export default WorkerFactory;
}

/**
 * Release version baked in by the app build (Vite `define` in
 * apps/web/vite.config.ts, sourced from the root package.json). Undefined
 * under vitest/tsx — read it through `typeof` guards only.
 */
declare const __CRYSTAL_VERSION__: string | undefined;

/** Shared ambient declarations for the whole workspace (wired in tsconfig.base.json). */

declare module "*?worker" {
  const WorkerFactory: new () => Worker;
  export default WorkerFactory;
}

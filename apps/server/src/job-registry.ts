import { overviewSourcesAtRef, snapshotAtRef, surfacesSnapshotAtRef } from "./ref-snapshot.js";

export const jobs = {
  refOverviewSources: overviewSourcesAtRef,
  refSurfacesSnapshot: surfacesSnapshotAtRef,
  refArchSnapshot: snapshotAtRef,
};

export type JobName = keyof typeof jobs;
export type JobArgs = Parameters<typeof jobs.refOverviewSources>;
export type JobResult<N extends JobName> = Awaited<ReturnType<(typeof jobs)[N]>>;

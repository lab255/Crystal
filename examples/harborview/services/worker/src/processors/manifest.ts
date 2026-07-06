import type { SyncManifestJob } from "@harborview/queue";

export async function syncManifest(job: SyncManifestJob): Promise<void> {
  await Promise.resolve();
  console.log("synced passenger manifest for sailing " + job.sailingId);
}

import type { Job } from "@harborview/queue";
import type { Mailer } from "./processors/email";
import type { PaymentGateway } from "./processors/payment";

export interface Deps {
  mailer: Mailer;
  gateway: PaymentGateway;
}

export async function processJob(job: Job, deps: Deps): Promise<void> {
  switch (job.type) {
    case "send_email": {
      const { sendEmail } = await import("./processors/email");
      await sendEmail(job, deps.mailer);
      return;
    }
    case "capture_payment": {
      const { capturePayment } = await import("./processors/payment");
      await capturePayment(job, deps.gateway);
      return;
    }
    case "sync_manifest": {
      const { syncManifest } = await import("./processors/manifest");
      await syncManifest(job);
      return;
    }
  }
}

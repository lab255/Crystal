export type JobType = "send_email" | "capture_payment" | "sync_manifest";

export interface BaseJob {
  id: string;
  type: JobType;
  createdAt: string;
}

export interface SendEmailJob extends BaseJob {
  type: "send_email";
  template: string;
  to: string;
  data: Record<string, unknown>;
}

export interface CapturePaymentJob extends BaseJob {
  type: "capture_payment";
  bookingId: string;
  amountCents: number;
  currency: string;
}

export interface SyncManifestJob extends BaseJob {
  type: "sync_manifest";
  sailingId: string;
}

export type Job = SendEmailJob | CapturePaymentJob | SyncManifestJob;

export const JOB_STREAM = "jobs";

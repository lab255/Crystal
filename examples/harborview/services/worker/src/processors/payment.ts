import type { CapturePaymentJob } from "@harborview/queue";
import { formatCurrency } from "../format";

export interface PaymentGateway {
  charge(
    amountCents: number,
    currency: string,
    reference: string,
  ): Promise<{ id: string; status: string }>;
}

export async function capturePayment(
  job: CapturePaymentJob,
  gateway: PaymentGateway,
): Promise<void> {
  const result = await gateway.charge(job.amountCents, job.currency, job.bookingId);
  if (result.status !== "succeeded") {
    throw new Error(
      "payment failed for " +
        job.bookingId +
        " (" +
        formatCurrency(job.amountCents, job.currency) +
        ")",
    );
  }
}

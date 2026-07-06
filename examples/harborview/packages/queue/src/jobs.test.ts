import { describe, expect, it } from "vitest";
import { JOB_STREAM } from "./jobs";
import type { Job } from "./jobs";

describe("job payloads", () => {
  it("round-trips through JSON", () => {
    const job: Job = {
      id: "job_1",
      type: "capture_payment",
      createdAt: "2026-07-01T00:00:00Z",
      bookingId: "bk_1",
      amountCents: 4500,
      currency: "USD",
    };
    const parsed = JSON.parse(JSON.stringify(job)) as Job;
    expect(parsed).toEqual(job);
    expect(JOB_STREAM).toBe("jobs");
  });
});

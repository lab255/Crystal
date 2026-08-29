import type { MessageRunResult } from "@crystal/client";

/** Extra delivery detail for orchestration queues; null lets the shared composer speak. */
export function steerReceiptText(result: MessageRunResult): string | null {
  if (!result.queued || typeof result.wakeExpected !== "boolean") return null;
  return result.wakeExpected
    ? "Queued — the manager wakes on the next settlement."
    : "Queued — no wake expected; it reads this when next resumed.";
}

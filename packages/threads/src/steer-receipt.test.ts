import { describe, expect, it } from "vitest";
import { steerReceiptText } from "./steer-receipt.js";

describe("steerReceiptText", () => {
  it("distinguishes queues that wake from queues that wait for a later resume", () => {
    expect(steerReceiptText({ queued: true, wakeExpected: true })).toContain("wakes");
    expect(steerReceiptText({ queued: true, wakeExpected: false })).toContain("no wake expected");
    expect(steerReceiptText({ queued: false, wakeExpected: true })).toBeNull();
  });
});

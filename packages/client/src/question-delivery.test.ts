import { describe, expect, it } from "vitest";
import { questionDeliveryNotice } from "./question-delivery.js";

describe("questionDeliveryNotice", () => {
  it("keeps resumed, queued, and recorded outcomes distinct", () => {
    expect(questionDeliveryNotice("resumed")).toContain("agent resumed");
    expect(questionDeliveryNotice("queued")).toContain("queued for the agent's next turn");
    expect(questionDeliveryNotice("recorded")).toContain(
      "recorded on the board (no agent will read it)",
    );
    expect(questionDeliveryNotice("recorded")).toContain("dismissal isn't needed");
  });
});

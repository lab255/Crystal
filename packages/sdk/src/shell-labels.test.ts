import { describe, expect, it } from "vitest";
import { TRAFFIC_LIGHTS, TRAFFIC_LIGHT_LABELS } from "@crystal/core";
import { attentionLegendText, DEV_SERVERS_TOOLTIP } from "./shell-labels.js";

describe("shell explanatory labels", () => {
  it("builds the attention legend from the core traffic-light vocabulary", () => {
    const legend = attentionLegendText();
    expect(legend).toContain(
      TRAFFIC_LIGHTS.map((light) => TRAFFIC_LIGHT_LABELS[light]).join(" / "),
    );
    expect(legend).toContain("open questions, failures and stalls");
  });

  it("explains the dev-server button's Surfaces relationship", () => {
    expect(DEV_SERVERS_TOOLTIP).toContain("Surfaces previews");
  });
});

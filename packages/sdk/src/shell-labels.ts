import { TRAFFIC_LIGHTS, TRAFFIC_LIGHT_LABELS } from "@crystal/core";

export const DEV_SERVERS_TOOLTIP = "Dev servers — powers the Surfaces previews";

export function attentionLegendText(): string {
  const states = TRAFFIC_LIGHTS.map((light) => TRAFFIC_LIGHT_LABELS[light]);
  return `Attention state: ${states.join(" / ")} — from open questions, failures and stalls`;
}

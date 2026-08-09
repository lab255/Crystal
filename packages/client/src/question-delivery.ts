export type QuestionDelivery = "resumed" | "queued" | "recorded";

/** Human copy for the typed answer-delivery contract. */
export function questionDeliveryNotice(delivery: QuestionDelivery): string {
  if (delivery === "resumed") return "Answer saved — agent resumed.";
  if (delivery === "queued") {
    return "Answer saved — queued for the agent's next turn.";
  }
  return (
    "Answer recorded on the board (no agent will read it). " +
    "The question is closed, so dismissal isn't needed."
  );
}

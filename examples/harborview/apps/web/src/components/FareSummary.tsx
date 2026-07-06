import type { FareQuote } from "@harborview/core";
import { formatCurrency } from "../format";

export interface FareSummaryProps {
  quote: FareQuote;
}

export function FareSummary({ quote }: FareSummaryProps) {
  return (
    <div className="fare-summary">
      <ul>
        {quote.lines.map((line, index) => (
          <li key={index}>
            <span>{line.label}</span>
            <span>{formatCurrency(line.amountCents, quote.currency)}</span>
          </li>
        ))}
      </ul>
      <strong>Total: {formatCurrency(quote.totalCents, quote.currency)}</strong>
    </div>
  );
}

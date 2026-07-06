export function formatCurrency(amountCents: number, currency: string): string {
  const negative = amountCents < 0;
  const abs = Math.abs(amountCents);
  const whole = Math.floor(abs / 100);
  const fraction = String(abs % 100).padStart(2, "0");
  const grouped = whole.toLocaleString("en-US");
  const symbol = currency === "USD" ? "$" : currency + " ";
  const body = symbol + grouped + "." + fraction;
  return negative ? "-" + body : body;
}

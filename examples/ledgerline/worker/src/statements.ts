import { monthKey, type Money } from "@ledgerline/shared";
import { formatMoney } from "./format.js";
import { sendMail } from "./mailer.js";

export interface StatementLine {
  customerEmail: string;
  invoiceNumber: string;
  total: Money;
  issuedAt: string;
}

/** Split rows into fixed-size pages. */
export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** One statement email per customer per month, batched to be gentle on SMTP. */
export async function sendMonthlyStatements(lines: StatementLine[] = []): Promise<number> {
  const byCustomer = new Map<string, StatementLine[]>();
  for (const line of lines) {
    const list = byCustomer.get(line.customerEmail) ?? [];
    list.push(line);
    byCustomer.set(line.customerEmail, list);
  }
  let sent = 0;
  for (const batch of chunk([...byCustomer.entries()], 20)) {
    for (const [email, rows] of batch) {
      const body = rows
        .map((r) => `${monthKey(r.issuedAt)}  ${r.invoiceNumber}  ${formatMoney(r.total)}`)
        .join("\n");
      await sendMail({ to: email, subject: "Your monthly statement", body });
      sent += 1;
    }
  }
  return sent;
}

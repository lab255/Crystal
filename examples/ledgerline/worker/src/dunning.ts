import { isOverdue, type Money } from "@ledgerline/shared";
import { formatMoney } from "./format.js";
import { sendMail } from "./mailer.js";

export interface DunningTarget {
  invoiceNumber: string;
  customerEmail: string;
  total: Money;
  dueAt: string;
}

const REMINDER_GRACE_DAYS = 3;

/** Chase overdue invoices: one polite nudge per invoice per run. */
export async function runDunning(targets: DunningTarget[] = []): Promise<number> {
  let sent = 0;
  for (const target of targets) {
    if (!isOverdue(target.dueAt, REMINDER_GRACE_DAYS)) continue;
    await sendMail({
      to: target.customerEmail,
      subject: `Reminder: invoice ${target.invoiceNumber} is overdue`,
      body: `Invoice ${target.invoiceNumber} for ${formatMoney(target.total)} was due ${target.dueAt.slice(0, 10)}.`,
    });
    sent += 1;
  }
  return sent;
}

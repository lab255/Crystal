import { addMoney, zeroMoney, type Money } from "@ledgerline/shared";
import type { LedgerEntry } from "../db.js";

/** Account balance = debits − credits over the entries that touch it. */
export function accountBalance(entries: LedgerEntry[], account: string): Money {
  let balance = zeroMoney(entries[0]?.amount.currency ?? "USD");
  for (const entry of entries) {
    if (entry.debitAccount === account) balance = addMoney(balance, entry.amount);
    if (entry.creditAccount === account) {
      balance = { ...balance, amount: balance.amount - entry.amount.amount };
    }
  }
  return balance;
}

/** Trial balance: every account touched, with its net balance. */
export function trialBalance(entries: LedgerEntry[]): Map<string, Money> {
  const accounts = new Set<string>();
  for (const e of entries) {
    accounts.add(e.debitAccount);
    accounts.add(e.creditAccount);
  }
  const out = new Map<string, Money>();
  for (const account of [...accounts].sort()) {
    out.set(account, accountBalance(entries, account));
  }
  return out;
}

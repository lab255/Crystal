import { negateMoney, nowIso, uid, type Money } from "@ledgerline/shared";
import type { LedgerEntry, Store } from "../db.js";

/** Post a balanced double-entry pair; returns the created entry. */
export function postEntry(
  store: Store,
  orgId: string,
  debitAccount: string,
  creditAccount: string,
  amount: Money,
  memo: string,
): LedgerEntry {
  if (amount.amount <= 0) throw new Error("Ledger entries must be positive");
  const entry: LedgerEntry = {
    id: uid("le"),
    orgId,
    debitAccount,
    creditAccount,
    amount,
    memo,
    postedAt: nowIso(),
  };
  store.entries.push(entry);
  return entry;
}

/** Reverse an entry (credits and debits swap) — used for voids/refunds. */
export function reverseEntry(store: Store, entry: LedgerEntry, memo: string): LedgerEntry {
  return postEntry(
    store,
    entry.orgId,
    entry.creditAccount,
    entry.debitAccount,
    negateMoney(negateMoney(entry.amount)),
    memo,
  );
}

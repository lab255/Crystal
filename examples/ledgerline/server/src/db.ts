import type { Money } from "@ledgerline/shared";

export interface Customer {
  id: string;
  orgId: string;
  name: string;
  slug: string;
  email: string;
}

export interface Invoice {
  id: string;
  orgId: string;
  customerId: string;
  number: string;
  status: "draft" | "sent" | "paid" | "void";
  total: Money;
  issuedAt: string;
  dueAt: string;
}

export interface LedgerEntry {
  id: string;
  orgId: string;
  debitAccount: string;
  creditAccount: string;
  amount: Money;
  memo: string;
  postedAt: string;
}

/** Naive in-memory store standing in for Postgres in this fixture. */
export interface Store {
  customers: Map<string, Customer>;
  invoices: Map<string, Invoice>;
  entries: LedgerEntry[];
}

export function createStore(_databaseUrl: string): Store {
  return { customers: new Map(), invoices: new Map(), entries: [] };
}

export function invoicesForOrg(store: Store, orgId: string): Invoice[] {
  return [...store.invoices.values()].filter((i) => i.orgId === orgId);
}

export function overdueInvoices(store: Store, orgId: string): Invoice[] {
  const now = Date.now();
  return invoicesForOrg(store, orgId).filter(
    (i) => i.status === "sent" && new Date(i.dueAt).getTime() < now,
  );
}

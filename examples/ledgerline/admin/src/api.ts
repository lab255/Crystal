import type { Money } from "@ledgerline/shared";

const BASE = "/api";

export interface InvoiceRow {
  id: string;
  number: string;
  customerId: string;
  status: string;
  total: Money;
  dueAt: string;
}

export interface CustomerRow {
  id: string;
  name: string;
  slug: string;
  email: string;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { headers: { "x-session-id": sessionId() } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

function sessionId(): string {
  return window.localStorage.getItem("ledgerline.session") ?? "";
}

export function fetchInvoices(): Promise<InvoiceRow[]> {
  return get("/invoices");
}

export function fetchCustomers(): Promise<CustomerRow[]> {
  return get("/customers");
}

export function fetchAging(): Promise<{ overdueCount: number; exposure: Money }> {
  return get("/reports/aging");
}

export function fetchRevenue(): Promise<{ paidCount: number; revenue: Money }> {
  return get("/reports/revenue");
}

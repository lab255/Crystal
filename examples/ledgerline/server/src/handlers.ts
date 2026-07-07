/**
 * Every route handler in one file — invoices, customers, payments, reports.
 * Grew organically; splitting it by domain is a known chore.
 */
import type { Request, Response } from "express";
import {
  addDays,
  addMoney,
  nowIso,
  uid,
  zeroMoney,
  type Money,
} from "@ledgerline/shared";
import { chunk } from "../../worker/src/statements.js";
import type { ServerConfig } from "./config.js";
import { invoicesForOrg, overdueInvoices, type Invoice, type Store } from "./db.js";
import { postEntry } from "./ledger/ledger.js";
import { trialBalance } from "./ledger/posting.js";
import { slugify } from "./util.js";

/* ---------------- customers ---------------- */

export function createCustomer(store: Store) {
  return (req: Request, res: Response): void => {
    const { name, email } = req.body as { name?: string; email?: string };
    if (!name || !email) {
      res.status(400).json({ error: "name and email are required" });
      return;
    }
    const customer = {
      id: uid("cust"),
      orgId: res.locals.orgId as string,
      name,
      slug: slugify(name),
      email,
    };
    store.customers.set(customer.id, customer);
    res.status(201).json(customer);
  };
}

export function listCustomers(store: Store) {
  return (_req: Request, res: Response): void => {
    const orgId = res.locals.orgId as string;
    res.json([...store.customers.values()].filter((c) => c.orgId === orgId));
  };
}

/* ---------------- invoices ---------------- */

export function createInvoice(store: Store) {
  return (req: Request, res: Response): void => {
    const { customerId, total } = req.body as { customerId?: string; total?: Money };
    const customer = customerId ? store.customers.get(customerId) : undefined;
    if (!customer || !total || total.amount <= 0) {
      res.status(400).json({ error: "customerId and a positive total are required" });
      return;
    }
    const invoice: Invoice = {
      id: uid("inv"),
      orgId: res.locals.orgId as string,
      customerId: customer.id,
      number: `INV-${store.invoices.size + 1}`,
      status: "draft",
      total,
      issuedAt: nowIso(),
      dueAt: addDays(nowIso(), 30),
    };
    store.invoices.set(invoice.id, invoice);
    res.status(201).json(invoice);
  };
}

export function sendInvoice(store: Store) {
  return (req: Request, res: Response): void => {
    const invoice = store.invoices.get(req.params.id ?? "");
    if (!invoice || invoice.status !== "draft") {
      res.status(409).json({ error: "invoice is not a draft" });
      return;
    }
    invoice.status = "sent";
    postEntry(
      store,
      invoice.orgId,
      "accounts-receivable",
      "revenue",
      invoice.total,
      `Invoice ${invoice.number} sent`,
    );
    res.json(invoice);
  };
}

export function recordPayment(store: Store) {
  return (req: Request, res: Response): void => {
    const invoice = store.invoices.get(req.params.id ?? "");
    if (!invoice || invoice.status !== "sent") {
      res.status(409).json({ error: "invoice is not awaiting payment" });
      return;
    }
    invoice.status = "paid";
    postEntry(
      store,
      invoice.orgId,
      "cash",
      "accounts-receivable",
      invoice.total,
      `Invoice ${invoice.number} paid`,
    );
    res.json(invoice);
  };
}

/* ---------------- reports ---------------- */

export function agingReport(store: Store, config: ServerConfig) {
  return (_req: Request, res: Response): void => {
    const orgId = res.locals.orgId as string;
    const overdue = overdueInvoices(store, orgId);
    let exposure = zeroMoney();
    for (const invoice of overdue) exposure = addMoney(exposure, invoice.total);
    // Page the rows so huge orgs don't blow up the admin table.
    const pages = chunk(overdue, 50);
    res.json({
      graceDays: config.dunningGraceDays,
      overdueCount: overdue.length,
      exposure,
      pages: pages.length,
      rows: pages[0] ?? [],
    });
  };
}

export function trialBalanceReport(store: Store) {
  return (_req: Request, res: Response): void => {
    const orgId = res.locals.orgId as string;
    const entries = store.entries.filter((e) => e.orgId === orgId);
    res.json(Object.fromEntries(trialBalance(entries)));
  };
}

export function revenueSummary(store: Store) {
  return (_req: Request, res: Response): void => {
    const orgId = res.locals.orgId as string;
    const paid = invoicesForOrg(store, orgId).filter((i) => i.status === "paid");
    let revenue = zeroMoney();
    for (const invoice of paid) revenue = addMoney(revenue, invoice.total);
    res.json({ paidCount: paid.length, revenue });
  };
}

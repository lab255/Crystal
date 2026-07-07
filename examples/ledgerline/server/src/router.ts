import { Router } from "express";
import { requireAuth } from "./auth/middleware.js";
import type { ServerConfig } from "./config.js";
import type { Store } from "./db.js";
import {
  agingReport,
  createCustomer,
  createInvoice,
  listCustomers,
  recordPayment,
  revenueSummary,
  sendInvoice,
  trialBalanceReport,
} from "./handlers.js";

export function buildRouter(store: Store, config: ServerConfig): Router {
  const router = Router();
  const auth = requireAuth(config);
  router.get("/health", (_req, res) => res.json({ ok: true }));
  router.post("/customers", auth, createCustomer(store));
  router.get("/customers", auth, listCustomers(store));
  router.post("/invoices", auth, createInvoice(store));
  router.post("/invoices/:id/send", auth, sendInvoice(store));
  router.post("/invoices/:id/payment", auth, recordPayment(store));
  router.get("/reports/aging", auth, agingReport(store, config));
  router.get("/reports/trial-balance", auth, trialBalanceReport(store));
  router.get("/reports/revenue", auth, revenueSummary(store));
  return router;
}

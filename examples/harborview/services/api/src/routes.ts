import { Router } from "express";
import type { AppContext } from "./context";
import { makeCreateBookingHandler } from "./handlers/bookings";
import { makeAvailabilityHandler } from "./handlers/availability";
import { makeWebhookHandler } from "./handlers/webhooks";
import { handleHealth } from "./handlers/health";
import { requireApiKey } from "./middleware/auth";

export function registerRoutes(ctx: AppContext, webhookSecret: string, apiKey: string): Router {
  const router = Router();
  router.get("/health", handleHealth);
  router.get("/availability", makeAvailabilityHandler(ctx));
  router.post("/bookings", requireApiKey(apiKey), makeCreateBookingHandler(ctx));
  router.post("/webhooks/payments", makeWebhookHandler(ctx, webhookSecret));
  return router;
}

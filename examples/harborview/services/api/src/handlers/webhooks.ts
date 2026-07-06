import type { Request, Response } from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { AppContext } from "../context";

export function verifySignature(secret: string, payload: string, signature: string): boolean {
  const expected = createHmac("sha256", secret).update(payload).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

interface PaymentEvent {
  bookingId: string;
  status: "succeeded" | "failed";
}

export function makeWebhookHandler(ctx: AppContext, secret: string) {
  return async function handlePaymentWebhook(req: Request, res: Response): Promise<void> {
    const signature = String(req.headers["x-signature"] ?? "");
    const raw = JSON.stringify(req.body);
    if (!verifySignature(secret, raw, signature)) {
      res.status(401).json({ error: "invalid signature" });
      return;
    }

    const event = req.body as PaymentEvent;
    if (event.status === "succeeded") {
      await ctx.bookings.updateStatus(event.bookingId, "confirmed");
    } else {
      await ctx.bookings.updateStatus(event.bookingId, "cancelled");
    }
    res.json({ received: true });
  };
}

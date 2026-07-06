import type { Request, Response } from "express";
import { z } from "zod";
import { createBooking, uid } from "@harborview/core";
import { nowIso } from "@harborview/queue";
import type { AppContext } from "../context";

const bookingSchema = z.object({
  sailingId: z.string(),
  baseFareCents: z.number().int().positive(),
  departAt: z.string(),
  contactEmail: z.string().email(),
  promoCode: z.string().optional(),
  passengers: z
    .array(
      z.object({
        fullName: z.string().min(1),
        email: z.string().email(),
        fareClass: z.enum(["economy", "premium", "vehicle"]),
      }),
    )
    .min(1),
});

export function makeCreateBookingHandler(ctx: AppContext) {
  return async function handleCreateBooking(req: Request, res: Response): Promise<void> {
    const input = bookingSchema.parse(req.body);
    const booking = createBooking(input);

    await ctx.bookings.insert(booking);
    await ctx.sailings.decrementSeats(booking.sailingId, booking.passengers.length);

    await ctx.publisher.publish({
      id: uid("job"),
      type: "capture_payment",
      createdAt: nowIso(),
      bookingId: booking.id,
      amountCents: booking.quote.totalCents,
      currency: booking.quote.currency,
    });
    await ctx.publisher.publish({
      id: uid("job"),
      type: "send_email",
      createdAt: nowIso(),
      template: "booking_confirmation",
      to: booking.contactEmail,
      data: { bookingId: booking.id, totalCents: booking.quote.totalCents },
    });

    res.status(201).json(booking);
  };
}

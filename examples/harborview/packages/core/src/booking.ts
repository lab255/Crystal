import type { Booking, Passenger, CancellationResult } from "./types";
import { quoteFare } from "./pricing";
import { cancellationPenalty } from "./cancellation";
import { uid } from "./util";

export interface CreateBookingInput {
  sailingId: string;
  baseFareCents: number;
  departAt: string;
  passengers: Passenger[];
  contactEmail: string;
  promoCode?: string;
}

export function createBooking(input: CreateBookingInput): Booking {
  if (input.passengers.length === 0) {
    throw new Error("a booking needs at least one passenger");
  }

  const quote = quoteFare({
    sailingId: input.sailingId,
    baseFareCents: input.baseFareCents,
    passengers: input.passengers,
    promoCode: input.promoCode,
    departAt: input.departAt,
  });

  return {
    id: uid("bk"),
    sailingId: input.sailingId,
    status: "pending",
    passengers: input.passengers,
    quote,
    createdAt: new Date().toISOString(),
    contactEmail: input.contactEmail,
  };
}

export function confirmBooking(booking: Booking): Booking {
  return { ...booking, status: "confirmed" };
}

export function cancelBooking(booking: Booking, hoursBeforeDeparture: number): CancellationResult {
  const penalty = cancellationPenalty(booking.quote.totalCents, hoursBeforeDeparture);
  return {
    bookingId: booking.id,
    penaltyCents: penalty,
    refundCents: booking.quote.totalCents - penalty,
    status: "cancelled",
  };
}

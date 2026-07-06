import { useState } from "react";
import type { Booking } from "@harborview/core";
import { apiClient } from "../api/client";
import type { CreateBookingBody } from "../api/client";

export function useBooking() {
  const [booking, setBooking] = useState<Booking | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(body: CreateBookingBody): Promise<void> {
    setSubmitting(true);
    setError(null);
    try {
      const created = await apiClient.createBooking(body);
      setBooking(created);
    } catch (err) {
      setError(err instanceof Error ? err.message : "unknown error");
    } finally {
      setSubmitting(false);
    }
  }

  return { booking, error, submitting, submit };
}

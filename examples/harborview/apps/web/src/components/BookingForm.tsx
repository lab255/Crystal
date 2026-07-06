import { useState } from "react";
import type { FormEvent } from "react";
import { useBooking } from "../hooks/useBooking";
import { FareSummary } from "./FareSummary";

export interface BookingFormProps {
  sailingId: string;
  baseFareCents: number;
  departAt: string;
}

export function BookingForm({ sailingId, baseFareCents, departAt }: BookingFormProps) {
  const { booking, error, submitting, submit } = useBooking();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    void submit({
      sailingId,
      baseFareCents,
      departAt,
      contactEmail: email,
      passengers: [{ fullName: name, email, fareClass: "economy" }],
    });
  }

  return (
    <form onSubmit={handleSubmit}>
      <input value={name} placeholder="Full name" onChange={(e) => setName(e.target.value)} />
      <input value={email} placeholder="Email" onChange={(e) => setEmail(e.target.value)} />
      <button type="submit" disabled={submitting}>
        Book now
      </button>
      {error && <p className="error">{error}</p>}
      {booking && <FareSummary quote={booking.quote} />}
    </form>
  );
}

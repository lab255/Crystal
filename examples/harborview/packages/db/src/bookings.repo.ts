import type { Booking, BookingStatus } from "@harborview/core";
import { Database } from "./client";

interface BookingRow {
  id: string;
  sailing_id: string;
  status: BookingStatus;
  contact_email: string;
  total_cents: number;
  created_at: string;
  passengers: string;
  quote: string;
}

export class BookingsRepository {
  constructor(private db: Database) {}

  async insert(booking: Booking): Promise<Booking> {
    await this.db.query(
      "INSERT INTO bookings (id, sailing_id, status, contact_email, total_cents, created_at, passengers, quote) " +
        "VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
      [
        booking.id,
        booking.sailingId,
        booking.status,
        booking.contactEmail,
        booking.quote.totalCents,
        booking.createdAt,
        JSON.stringify(booking.passengers),
        JSON.stringify(booking.quote),
      ],
    );
    return booking;
  }

  async findById(id: string): Promise<Booking | null> {
    const result = await this.db.query<BookingRow>("SELECT * FROM bookings WHERE id = $1", [id]);
    const row = result.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      sailingId: row.sailing_id,
      status: row.status,
      contactEmail: row.contact_email,
      createdAt: row.created_at,
      passengers: JSON.parse(row.passengers),
      quote: JSON.parse(row.quote),
    };
  }

  async updateStatus(id: string, status: BookingStatus): Promise<void> {
    await this.db.query("UPDATE bookings SET status = $1 WHERE id = $2", [status, id]);
  }
}

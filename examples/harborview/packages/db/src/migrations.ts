import { Database } from "./client";

export const MIGRATIONS: string[] = [
  `CREATE TABLE IF NOT EXISTS vessels (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    capacity INTEGER NOT NULL,
    home_port TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sailings (
    id TEXT PRIMARY KEY,
    route_id TEXT NOT NULL,
    depart_at TIMESTAMPTZ NOT NULL,
    seats_available INTEGER NOT NULL,
    base_fare_cents INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS bookings (
    id TEXT PRIMARY KEY,
    sailing_id TEXT NOT NULL REFERENCES sailings(id),
    status TEXT NOT NULL,
    contact_email TEXT NOT NULL,
    total_cents INTEGER NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    passengers JSONB NOT NULL,
    quote JSONB NOT NULL
  )`,
];

export async function runMigrations(db: Database): Promise<void> {
  for (const sql of MIGRATIONS) {
    await db.query(sql);
  }
}

import type { Sailing } from "@harborview/core";
import { Database } from "./client";

export class SailingsRepository {
  constructor(private db: Database) {}

  async listByRoute(routeId: string): Promise<Sailing[]> {
    const result = await this.db.query<Sailing>(
      "SELECT id, route_id AS \"routeId\", depart_at AS \"departAt\", " +
        "seats_available AS \"seatsAvailable\", base_fare_cents AS \"baseFareCents\" " +
        "FROM sailings WHERE route_id = $1 ORDER BY depart_at",
      [routeId],
    );
    return result.rows;
  }

  async findById(id: string): Promise<Sailing | null> {
    const result = await this.db.query<Sailing>("SELECT * FROM sailings WHERE id = $1", [id]);
    return result.rows[0] ?? null;
  }

  async decrementSeats(id: string, count: number): Promise<void> {
    await this.db.query(
      "UPDATE sailings SET seats_available = seats_available - $1 WHERE id = $2 AND seats_available >= $1",
      [count, id],
    );
  }
}

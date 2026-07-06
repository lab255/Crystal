import type { Vessel } from "@harborview/core";
import { Database } from "./client";

export class VesselsRepository {
  constructor(private db: Database) {}

  async all(): Promise<Vessel[]> {
    const result = await this.db.query<Vessel>(
      "SELECT id, name, capacity, home_port AS \"homePort\" FROM vessels ORDER BY name",
    );
    return result.rows;
  }

  async findById(id: string): Promise<Vessel | null> {
    const result = await this.db.query<Vessel>(
      "SELECT id, name, capacity, home_port AS \"homePort\" FROM vessels WHERE id = $1",
      [id],
    );
    return result.rows[0] ?? null;
  }
}

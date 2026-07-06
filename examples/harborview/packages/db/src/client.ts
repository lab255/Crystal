import { Pool } from "pg";

export interface DbConfig {
  connectionString: string;
  max?: number;
}

export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

export class Database {
  private pool: Pool;

  constructor(config: DbConfig) {
    this.pool = new Pool({ connectionString: config.connectionString, max: config.max ?? 10 });
  }

  async query<T>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    const result = await this.pool.query(sql, params);
    return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 };
  }

  async transaction<T>(fn: (db: Database) => Promise<T>): Promise<T> {
    await this.query("BEGIN");
    try {
      const value = await fn(this);
      await this.query("COMMIT");
      return value;
    } catch (error) {
      await this.query("ROLLBACK");
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export function createDatabase(connectionString: string): Database {
  return new Database({ connectionString });
}

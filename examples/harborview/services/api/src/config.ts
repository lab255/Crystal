export interface ApiConfig {
  port: number;
  databaseUrl: string;
  redisUrl: string;
  webhookSecret: string;
  apiKey: string;
}

export function parseEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 0) {
    throw new Error("invalid integer for " + name + ": " + raw);
  }
  return parsed;
}

export function loadConfig(): ApiConfig {
  return {
    port: parseEnvInt("PORT", 8080),
    databaseUrl: process.env.DATABASE_URL ?? "postgres://localhost:5432/harborview",
    redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
    webhookSecret: process.env.WEBHOOK_SECRET ?? "dev-secret",
    apiKey: process.env.API_KEY ?? "dev-api-key",
  };
}

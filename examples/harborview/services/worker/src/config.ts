export interface WorkerConfig {
  redisUrl: string;
  databaseUrl: string;
  concurrency: number;
  smtpUrl: string;
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

export function loadWorkerConfig(): WorkerConfig {
  return {
    redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
    databaseUrl: process.env.DATABASE_URL ?? "postgres://localhost:5432/harborview",
    concurrency: parseEnvInt("WORKER_CONCURRENCY", 4),
    smtpUrl: process.env.SMTP_URL ?? "smtp://localhost:1025",
  };
}

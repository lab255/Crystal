export interface ServerConfig {
  port: number;
  databaseUrl: string;
  sessionSecret: string;
  tokenSecret: string;
  dunningGraceDays: number;
}

export function loadConfig(): ServerConfig {
  return {
    port: Number(process.env.PORT ?? 8080),
    databaseUrl: process.env.DATABASE_URL ?? "postgres://localhost:5432/ledgerline",
    sessionSecret: process.env.SESSION_SECRET ?? "dev-session-secret",
    tokenSecret: process.env.TOKEN_SECRET ?? "dev-token-secret",
    dunningGraceDays: Number(process.env.DUNNING_GRACE_DAYS ?? 3),
  };
}

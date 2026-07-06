import express from "express";
import pino from "pino";
import type { AppContext } from "./context";
import type { ApiConfig } from "./config";
import { registerRoutes } from "./routes";
import { makeErrorHandler } from "./middleware/error";

export function createServer(ctx: AppContext, config: ApiConfig) {
  const app = express();
  const logger = pino({ name: "harborview-api" });

  app.use(express.json());
  app.use("/api", registerRoutes(ctx, config.webhookSecret, config.apiKey));
  app.use(makeErrorHandler(logger));

  return app;
}

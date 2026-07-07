import express from "express";
import { loadConfig } from "./config.js";
import { createStore } from "./db.js";
import { buildRouter } from "./router.js";

export function start(): void {
  const config = loadConfig();
  const store = createStore(config.databaseUrl);
  const app = express();
  app.use(express.json());
  app.use(buildRouter(store, config));
  app.listen(config.port, () => {
    console.log(`ledgerline server on :${config.port}`);
  });
}

start();

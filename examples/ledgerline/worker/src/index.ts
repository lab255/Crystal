import { runDunning } from "./dunning.js";
import { sendMonthlyStatements } from "./statements.js";

const INTERVAL_MS = 15 * 60 * 1000;

export function start(): void {
  console.log("ledgerline worker started");
  setInterval(() => {
    void runDunning();
    void sendMonthlyStatements();
  }, INTERVAL_MS);
}

start();

import { loadConfig } from "./config";
import { createContext } from "./context";
import { createServer } from "./server";

export function bootstrap() {
  const config = loadConfig();
  const ctx = createContext(config);
  const app = createServer(ctx, config);
  return { app, config };
}

export function main(): void {
  const { app, config } = bootstrap();
  app.listen(config.port, () => {
    console.log("harborview api listening on port " + config.port);
  });
}

main();

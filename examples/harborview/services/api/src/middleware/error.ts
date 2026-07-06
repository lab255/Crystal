import type { Request, Response, NextFunction } from "express";
import type { Logger } from "pino";
import { ZodError } from "zod";

export function makeErrorHandler(logger: Logger) {
  return function errorHandler(
    err: unknown,
    _req: Request,
    res: Response,
    _next: NextFunction,
  ): void {
    if (err instanceof ZodError) {
      res.status(400).json({ error: "validation failed", issues: err.issues });
      return;
    }
    logger.error({ err }, "request failed");
    const message = err instanceof Error ? err.message : "internal error";
    res.status(500).json({ error: message });
  };
}

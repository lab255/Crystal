import type { Request, Response, NextFunction } from "express";

export function requireApiKey(expected: string) {
  return function apiKeyGuard(req: Request, res: Response, next: NextFunction): void {
    const key = req.headers["x-api-key"];
    if (key !== expected) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  };
}

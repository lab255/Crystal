import type { NextFunction, Request, Response } from "express";
import type { ServerConfig } from "../config.js";
import { verifySession } from "./session.js";
import { verifyToken } from "./tokens.js";

/** Cookie session (admin SPA) or bearer API token — either grants an org. */
export function requireAuth(config: ServerConfig) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const sessionId = req.header("x-session-id");
    if (sessionId) {
      const session = verifySession(sessionId);
      if (session) {
        res.locals.orgId = session.orgId;
        next();
        return;
      }
    }
    const bearer = req.header("authorization")?.replace(/^Bearer /, "");
    if (bearer) {
      const claims = verifyToken(bearer, config.tokenSecret);
      if (claims) {
        res.locals.orgId = claims.orgId;
        next();
        return;
      }
    }
    res.status(401).json({ error: "unauthorized" });
  };
}

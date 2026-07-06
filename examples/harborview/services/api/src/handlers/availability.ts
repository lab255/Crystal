import type { Request, Response } from "express";
import { searchAvailability } from "@harborview/core";
import type { FareClass } from "@harborview/core";
import type { AppContext } from "../context";

export function makeAvailabilityHandler(ctx: AppContext) {
  return async function handleSearchAvailability(req: Request, res: Response): Promise<void> {
    const routeId = String(req.query.routeId ?? "");
    const sailings = await ctx.sailings.listByRoute(routeId);
    const options = searchAvailability(sailings, {
      origin: String(req.query.origin ?? ""),
      destination: String(req.query.destination ?? ""),
      date: String(req.query.date ?? ""),
      passengers: Number(req.query.passengers ?? 1),
      fareClass: (String(req.query.fareClass ?? "economy") as FareClass),
    });
    res.json({ options });
  };
}

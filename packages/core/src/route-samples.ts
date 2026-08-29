import { z } from "zod";
import { CRYSTAL_DIR } from "./workspace.js";

/**
 * Route samples — the user-supplied values that make a parameterised screen
 * route (`/invite/:token`) previewable. The preview cannot guess a valid
 * token, so the value is entered once and kept with the repo in
 * `.crystal/surfaces.json`, keyed by the route pattern exactly as the
 * screens list shows it.
 */
export const ROUTE_SAMPLES_FILE = `${CRYSTAL_DIR}/surfaces.json`;

/** route pattern → param name → sample value. */
export type RouteSamples = Record<string, Record<string, string>>;

export const RouteSamplesFileSchema = z.object({
  routes: z.record(z.string(), z.record(z.string(), z.string())).default({}),
});
export type RouteSamplesFile = z.infer<typeof RouteSamplesFileSchema>;

const PARAM_RE = /:([A-Za-z_$][\w$]*)\??|\*/g;

/** Parameter names in order of appearance (`*` for a splat). */
export function routeParamNames(route: string): string[] {
  const out: string[] = [];
  for (const m of route.matchAll(PARAM_RE)) {
    const name = m[1] ?? "*";
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

/**
 * Substitute sample values into a route. Params without a sample stay
 * literal — the preview then shows exactly which ones are still missing.
 */
export function fillRouteParams(route: string, samples: Record<string, string> | undefined): string {
  if (!samples) return route;
  return route.replace(PARAM_RE, (whole, name: string | undefined) => {
    const value = samples[name ?? "*"];
    if (value === undefined || value === "") return whole;
    return name ? encodeURIComponent(value) : value;
  });
}

/** Params of `route` still lacking a non-empty sample. */
export function missingRouteParams(route: string, samples: Record<string, string> | undefined): string[] {
  return routeParamNames(route).filter((n) => !samples?.[n]);
}

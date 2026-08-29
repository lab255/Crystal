import { describe, expect, it } from "vitest";
import { fillRouteParams, missingRouteParams, routeParamNames } from "./route-samples.js";

describe("route samples", () => {
  it("lists params incl. optional and splat", () => {
    expect(routeParamNames("/invite/:token")).toEqual(["token"]);
    expect(routeParamNames("/a/:x/b/:y?/*")).toEqual(["x", "y", "*"]);
    expect(routeParamNames("/signin")).toEqual([]);
  });
  it("fills what it has and leaves the rest literal", () => {
    expect(fillRouteParams("/invite/:token", { token: "Xiq6j-pbl" })).toBe("/invite/Xiq6j-pbl");
    expect(fillRouteParams("/a/:x/:y", { x: "1" })).toBe("/a/1/:y");
    expect(fillRouteParams("/a/:x", undefined)).toBe("/a/:x");
    expect(fillRouteParams("/a/:x", { x: "" })).toBe("/a/:x");
    expect(fillRouteParams("/files/*", { "*": "docs/readme.md" })).toBe("/files/docs/readme.md");
  });
  it("url-encodes named values", () => {
    expect(fillRouteParams("/q/:term", { term: "a b/c" })).toBe("/q/a%20b%2Fc");
  });
  it("reports missing params", () => {
    expect(missingRouteParams("/a/:x/:y", { x: "1" })).toEqual(["y"]);
  });
});

import { describe, expect, it } from "vitest";
import { classifyDevUrl } from "./common.js";

describe("classifyDevUrl", () => {
  it("calls a running URL live only after it responds", () => {
    expect(classifyDevUrl("http://localhost:5173", true, "http://localhost:3000")).toEqual({
      url: "http://localhost:5173",
      availability: "live",
    });
    expect(classifyDevUrl("http://localhost:5173", false, "http://localhost:3000")).toEqual({
      url: "http://localhost:5173",
      availability: "expected",
    });
  });

  it("keeps an analyzer guess explicitly expected", () => {
    expect(classifyDevUrl(null, false, "http://localhost:3000")).toEqual({
      url: "http://localhost:3000",
      availability: "expected",
    });
    expect(classifyDevUrl("http://localhost:3000", true, "http://localhost:3000")).toEqual({
      url: "http://localhost:3000",
      availability: "live",
    });
    expect(classifyDevUrl(null, false, null)).toBeNull();
  });
});

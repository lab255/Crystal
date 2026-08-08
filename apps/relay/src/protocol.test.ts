import { describe, expect, it } from "vitest";
import { PUBLISH_PASSWORD_MIN_LEN } from "./protocol.js";

describe("relay protocol constants", () => {
  it("exports the password minimum enforced by the relay", () => {
    expect(PUBLISH_PASSWORD_MIN_LEN).toBe(8);
  });
});

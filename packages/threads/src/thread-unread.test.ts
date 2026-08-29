import { describe, expect, it } from "vitest";
import { threadReadKey } from "./thread-unread.js";

describe("threadReadKey", () => {
  it("keeps legacy bare ids and scopes cross-workspace ids", () => {
    expect(threadReadKey("r1")).toBe("r1");
    expect(threadReadKey("r1", { sid: "s1", ws: "w1" })).toBe("s1/w1/r1");
  });
});

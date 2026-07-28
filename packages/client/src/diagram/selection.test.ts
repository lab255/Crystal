import { describe, expect, it } from "vitest";
import { formatIdList, parseIdList, toggleIdInList } from "./selection.js";

describe("focus-filter id lists", () => {
  it("parses comma lists, ignoring blanks and padding", () => {
    expect(parseIdList("sys:a, sys:b,,sys:c ")).toEqual(["sys:a", "sys:b", "sys:c"]);
    expect(parseIdList(null)).toEqual([]);
    expect(parseIdList("")).toEqual([]);
  });

  it("formats canonically: deduped, empty collapses to null", () => {
    expect(formatIdList(["a", "b", "a"])).toBe("a,b");
    expect(formatIdList([])).toBeNull();
    expect(formatIdList([" ", ""])).toBeNull();
  });

  it("toggle adds when absent and removes when present", () => {
    expect(toggleIdInList(null, "a")).toBe("a");
    expect(toggleIdInList("a", "b")).toBe("a,b");
    expect(toggleIdInList("a,b", "a")).toBe("b");
    expect(toggleIdInList("a", "a")).toBeNull();
  });
});

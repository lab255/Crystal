import { describe, expect, it } from "vitest";
import { pasteInput } from "./terminal-manager.js";

describe("pasteInput", () => {
  it("wraps text in bracketed-paste markers and submits with a carriage return", () => {
    expect(pasteInput("hello")).toBe("\x1b[200~hello\x1b[201~\r");
  });

  it("keeps embedded newlines inside one paste (no line-by-line submission)", () => {
    // A multi-line agent prompt typed raw would submit at the first \n; as a
    // bracketed paste the TUI treats it as one message.
    const wrapped = pasteInput("line one\nline two");
    expect(wrapped).toBe("\x1b[200~line one\nline two\x1b[201~\r");
    expect(wrapped.indexOf("\r")).toBe(wrapped.length - 1);
  });
});

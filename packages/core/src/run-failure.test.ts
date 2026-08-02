import { describe, expect, it } from "vitest";
import { classifyRunFailure, formatResetsAt, runFailureHint } from "./run-failure.js";

describe("classifyRunFailure", () => {
  it("classifies context overflow phrasings", () => {
    for (const text of [
      "API Error: 400 {\"type\":\"invalid_request_error\",\"message\":\"prompt is too long: 214321 tokens > 200000 maximum\"}",
      "Error: input length and `max_tokens` exceed context limit",
      "The conversation is too long to continue",
      "request exceeds the model's maximum context length",
    ]) {
      expect(classifyRunFailure(text)?.kind, text).toBe("context_overflow");
    }
  });

  it("classifies usage limits and extracts the epoch reset suffix", () => {
    const failure = classifyRunFailure("Claude AI usage limit reached|1754083200");
    expect(failure?.kind).toBe("usage_limit");
    expect(failure?.resetsAt).toBe(new Date(1754083200 * 1000).toISOString());
  });

  it("keeps worded reset times as raw text", () => {
    const failure = classifyRunFailure("You've reached your 5-hour limit. Resets at 3:00 PM");
    expect(failure?.kind).toBe("usage_limit");
    expect(failure?.resetsAt).toBe("3:00 PM");
  });

  it("classifies auth failures", () => {
    for (const text of [
      "authentication_error: invalid x-api-key",
      "OAuth token has expired. Please run /login",
      "Error: Not logged in",
      "Your credit balance is too low to access the Anthropic API",
    ]) {
      expect(classifyRunFailure(text)?.kind, text).toBe("auth");
    }
  });

  it("prefers overflow over usage when both phrasings appear", () => {
    expect(
      classifyRunFailure("prompt is too long — rate limit exceeded while retrying")?.kind,
    ).toBe("context_overflow");
  });

  it("leaves genuine failures unclassified", () => {
    expect(classifyRunFailure("TypeError: cannot read properties of undefined")).toBeNull();
    expect(classifyRunFailure("claude exited with code 1")).toBeNull();
    expect(classifyRunFailure("")).toBeNull();
    expect(classifyRunFailure(null)).toBeNull();
  });

  it("caps the matched detail line", () => {
    const failure = classifyRunFailure(`prompt is too long ${"x".repeat(400)}`);
    expect(failure?.detail?.length).toBeLessThanOrEqual(301);
  });
});

describe("runFailureHint", () => {
  it("mentions the reset time when known", () => {
    const hint = runFailureHint({ kind: "usage_limit", resetsAt: "3:00 PM", detail: null });
    expect(hint).toContain("3:00 PM");
  });

  it("suggests handoff for overflow", () => {
    expect(runFailureHint({ kind: "context_overflow" })).toMatch(/hand off/i);
  });
});

describe("formatResetsAt", () => {
  it("passes non-ISO text through untouched", () => {
    expect(formatResetsAt("3:00 PM")).toBe("3:00 PM");
  });

  it("formats ISO timestamps to a local time", () => {
    const soon = new Date(Date.now() + 60_000).toISOString();
    expect(formatResetsAt(soon)).toMatch(/at /);
  });
});

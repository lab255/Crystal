import { describe, expect, it } from "vitest";
import { INSTANCE_ID_RE, publicClientUrl } from "./publish.js";

describe("publicClientUrl", () => {
  it("joins the relay origin and instance path", () => {
    expect(publicClientUrl("https://relay.example.com", "abc123def456")).toBe(
      "https://relay.example.com/i/abc123def456",
    );
  });

  it("tolerates a trailing slash", () => {
    expect(publicClientUrl("https://relay.example.com/", "abc123")).toBe(
      "https://relay.example.com/i/abc123",
    );
  });

  it("normalizes ws(s) origins to http(s) for the browser", () => {
    expect(publicClientUrl("wss://relay.example.com", "abc123")).toBe(
      "https://relay.example.com/i/abc123",
    );
    expect(publicClientUrl("ws://127.0.0.1:8787", "abc123")).toBe("http://127.0.0.1:8787/i/abc123");
  });

  it("keeps a plain http origin (local relay dev)", () => {
    expect(publicClientUrl("http://127.0.0.1:8787", "abc123")).toBe("http://127.0.0.1:8787/i/abc123");
  });

  it("throws on garbage instead of minting a broken share link", () => {
    expect(() => publicClientUrl("not a url", "abc123")).toThrow();
  });
});

describe("INSTANCE_ID_RE", () => {
  it("matches the ids the server mints (12 hex chars)", () => {
    expect(INSTANCE_ID_RE.test("0123456789ab")).toBe(true);
    expect(INSTANCE_ID_RE.test("nope!")).toBe(false);
  });
});

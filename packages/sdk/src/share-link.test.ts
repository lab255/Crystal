import { describe, expect, it } from "vitest";
import {
  composePublicLink,
  PUBLIC_LINK_COPIED_NOTICE,
  shareLinkFor,
} from "./share-link.js";

describe("public share links", () => {
  it("composes the relay base with the current deep-link hash", () => {
    expect(
      composePublicLink(
        "https://relay.example/i/crystal-123",
        "#/architect/architecture?ws=abc&lens=diff%3Abase",
      ),
    ).toBe(
      "https://relay.example/i/crystal-123#/architect/architecture?ws=abc&lens=diff%3Abase",
    );
  });

  it("replaces a stale public-base hash and tolerates a hash without #", () => {
    expect(composePublicLink("https://relay.example/i/id#old", "/projects")).toBe(
      "https://relay.example/i/id#/projects",
    );
  });

  it("uses a public URL only while publishing is enabled and publishable", () => {
    const local = "http://localhost:5173/#/projects";
    expect(
      shareLinkFor({ enabled: true, publicUrl: "https://relay/i/id" }, local, "#/projects"),
    ).toEqual({ href: "https://relay/i/id#/projects", public: true });
    expect(
      shareLinkFor({ enabled: false, publicUrl: "https://relay/i/id" }, local, "#/projects"),
    ).toEqual({ href: local, public: false });
    expect(shareLinkFor({ enabled: true, publicUrl: null }, local, "#/projects")).toEqual({
      href: local,
      public: false,
    });
    expect(PUBLIC_LINK_COPIED_NOTICE).toBe("public link copied");
  });
});

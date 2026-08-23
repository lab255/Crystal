import { describe, expect, it } from "vitest";
import type { ComponentSurface, SystemModule } from "@crystal/core";
import { classifyDevUrl, groupComponentsBySystem, storybookStoryUrl } from "./common.js";

const component = (name: string, file: string, usedBy: number): ComponentSurface => ({
  name,
  file,
  line: 1,
  usedBy,
  stories: [],
  screens: [],
});

const system = (id: string, name: string): SystemModule => ({ id, name }) as SystemModule;

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

describe("storybookStoryUrl", () => {
  it("builds a canvas URL and normalizes a trailing slash", () => {
    expect(storybookStoryUrl("http://localhost:6006/", "Forms/Button", "Primary CTA")).toBe(
      "http://localhost:6006/iframe.html?id=forms-button--primary-cta&viewMode=story",
    );
  });
});

describe("groupComponentsBySystem", () => {
  it("folds attribution and orders by count, then name, with Other last", () => {
    const alpha = system("alpha", "Alpha");
    const beta = system("beta", "Beta");
    const gamma = system("gamma", "Gamma");
    const components = [
      component("Loose", "misc/Loose.tsx", 8),
      component("BetaLow", "beta/Low.tsx", 1),
      component("Alpha", "alpha/Only.tsx", 2),
      component("BetaHigh", "beta/High.tsx", 7),
      component("Gamma", "gamma/Only.tsx", 3),
    ];

    const groups = groupComponentsBySystem(components, (file) =>
      file.startsWith("alpha/")
        ? alpha
        : file.startsWith("beta/")
          ? beta
          : file.startsWith("gamma/")
            ? gamma
            : null,
    );

    expect(groups.map((group) => [group.id, group.components.map((item) => item.name)])).toEqual([
      ["beta", ["BetaHigh", "BetaLow"]],
      ["alpha", ["Alpha"]],
      ["gamma", ["Gamma"]],
      ["__other__", ["Loose"]],
    ]);
  });
});

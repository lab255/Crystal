import { describe, expect, it } from "vitest";
import { parseSource } from "./code-map.js";

describe("parseSource", () => {
  it("extracts imports with names", () => {
    const { imports } = parseSource(
      "a.ts",
      `import React from "react";
import { useState, useEffect } from "react";
import * as path from "node:path";
import { helper } from "./util.js";
const lazy = () => import("./heavy.js");
export { thing } from "./things.js";
export * from "./all.js";`,
    );
    expect(imports.map((i) => i.specifier)).toEqual([
      "react",
      "react",
      "node:path",
      "./util.js",
      "./things.js",
      "./all.js",
      "./heavy.js",
    ]);
    expect(imports[0]!.names).toEqual(["React"]);
    expect(imports[1]!.names).toEqual(["useState", "useEffect"]);
    expect(imports[2]!.names).toEqual(["* as path"]);
  });

  it("extracts exported symbols with kinds", () => {
    const { exports } = parseSource(
      "widget.tsx",
      `export function makeThing() {}
export class Store {}
export interface Options {}
export enum Mode { A, B }
export type Alias = string;
export const VALUE = 1;
export const Widget = () => null;
export default function main() {}`,
    );
    const byName = Object.fromEntries(exports.map((e) => [e.name, e.kind]));
    expect(byName).toMatchObject({
      makeThing: "function",
      Store: "class",
      Options: "interface",
      Mode: "enum",
      Alias: "type",
      VALUE: "const",
      Widget: "component",
      main: "default",
    });
    expect(exports.find((e) => e.name === "Store")!.line).toBe(2);
  });

  it("marks re-exports and counts loc", () => {
    const parsed = parseSource("index.ts", `export { A, B } from "./a.js";\nexport * from "./b.js";\n`);
    expect(parsed.exports.map((e) => e.kind)).toEqual(["reexport", "reexport", "reexport"]);
    expect(parsed.loc).toBeGreaterThan(1);
  });

  it("detects components only in tsx-ish files", () => {
    const ts = parseSource("x.ts", `export const Widget = () => null;`);
    expect(ts.exports[0]!.kind).toBe("const");
    const tsx = parseSource("x.tsx", `export const Widget = () => null;`);
    expect(tsx.exports[0]!.kind).toBe("component");
  });
});

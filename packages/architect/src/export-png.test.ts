import { describe, expect, it } from "vitest";
import { diagramExportFilename, pngExportFrame } from "./export-png.js";

describe("diagramExportFilename", () => {
  it("uses safe workspace, view, and optional level segments", () => {
    expect(diagramExportFilename("Crystal IDE", "architecture", "containers", "png")).toBe(
      "crystal-ide-architecture-containers.png",
    );
    expect(diagramExportFilename("Crystal IDE", "infra", null, "png")).toBe(
      "crystal-ide-infra.png",
    );
  });
});

describe("pngExportFrame", () => {
  it("fits every bound with a readable one-to-one logical scale", () => {
    const bounds = { x: -100, y: 50, width: 2000, height: 1000 };
    const frame = pngExportFrame(bounds);
    expect(frame).toMatchObject({ width: 2128, height: 1128, viewport: { zoom: 1 } });

    const left = bounds.x * frame.viewport.zoom + frame.viewport.x;
    const top = bounds.y * frame.viewport.zoom + frame.viewport.y;
    const right = (bounds.x + bounds.width) * frame.viewport.zoom + frame.viewport.x;
    const bottom = (bounds.y + bounds.height) * frame.viewport.zoom + frame.viewport.y;
    expect(left).toBeGreaterThanOrEqual(64);
    expect(top).toBeGreaterThanOrEqual(64);
    expect(right).toBeLessThanOrEqual(frame.width - 64);
    expect(bottom).toBeLessThanOrEqual(frame.height - 64);
  });

  it("gives small diagrams a document-friendly minimum canvas", () => {
    expect(pngExportFrame({ x: 0, y: 0, width: 200, height: 100 })).toMatchObject({
      width: 1200,
      height: 800,
      viewport: { zoom: 1 },
    });
  });
});

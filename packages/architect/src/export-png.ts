import { getViewportForBounds, type Node, type Rect, type Viewport } from "@xyflow/react";
import { toPng } from "html-to-image";

const EXPORT_PADDING = 64;
const MIN_EXPORT_WIDTH = 1200;
const MIN_EXPORT_HEIGHT = 800;

export interface PngExportFrame {
  width: number;
  height: number;
  viewport: Viewport;
}

/** Keep cards at one CSS pixel per flow pixel; the raster itself is rendered at 2x. */
export function pngExportFrame(bounds: Rect): PngExportFrame {
  const safeBounds = {
    ...bounds,
    width: Math.max(1, bounds.width),
    height: Math.max(1, bounds.height),
  };
  const width = Math.ceil(Math.max(MIN_EXPORT_WIDTH, safeBounds.width + EXPORT_PADDING * 2));
  const height = Math.ceil(
    Math.max(MIN_EXPORT_HEIGHT, safeBounds.height + EXPORT_PADDING * 2),
  );
  return {
    width,
    height,
    viewport: getViewportForBounds(safeBounds, width, height, 0.05, 1, `${EXPORT_PADDING}px`),
  };
}

function filenamePart(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "diagram"
  );
}

export function diagramExportFilename(
  workspace: string,
  view: string,
  level: string | null | undefined,
  extension: "png" | "mmd",
): string {
  return [workspace, view, level]
    .filter((part): part is string => Boolean(part))
    .map(filenamePart)
    .join("-")
    .concat(`.${extension}`);
}

function shouldExportNode(node: HTMLElement): boolean {
  return !(
    node.classList?.contains("react-flow__minimap") ||
    node.classList?.contains("react-flow__controls")
  );
}

function downloadDataUrl(dataUrl: string, filename: string): void {
  const link = document.createElement("a");
  link.download = filename;
  link.href = dataUrl;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function flowBackground(flow: HTMLElement): string {
  const own = getComputedStyle(flow).backgroundColor;
  if (own && own !== "transparent" && own !== "rgba(0, 0, 0, 0)") return own;
  return getComputedStyle(document.body).backgroundColor;
}

/**
 * Clone the pane rather than mutating the live viewport. Callers that use
 * React Flow's DOM virtualization must render all nodes before invoking this.
 */
export async function exportReactFlowPng(args: {
  root: HTMLElement;
  nodes: readonly Node[];
  bounds: Rect;
  filename: string;
}): Promise<void> {
  if (args.nodes.length === 0) throw new Error("The diagram has no nodes to export.");
  const flow = args.root.querySelector<HTMLElement>(".react-flow");
  const viewport = flow?.querySelector<HTMLElement>(".react-flow__viewport");
  const pane = viewport?.parentElement;
  if (!flow || !viewport || !pane) throw new Error("The diagram canvas is not ready.");

  const frame = pngExportFrame(args.bounds);
  const staging = document.createElement("div");
  staging.className = flow.className;
  Object.assign(staging.style, {
    position: "fixed",
    left: "-100000px",
    top: "0",
    width: `${frame.width}px`,
    height: `${frame.height}px`,
    overflow: "hidden",
    pointerEvents: "none",
  });

  const paneClone = pane.cloneNode(true) as HTMLElement;
  paneClone.style.position = "relative";
  paneClone.style.inset = "auto";
  paneClone.style.width = `${frame.width}px`;
  paneClone.style.height = `${frame.height}px`;
  const viewportClone = paneClone.querySelector<HTMLElement>(".react-flow__viewport");
  if (!viewportClone) throw new Error("The diagram viewport is not ready.");
  const { x, y, zoom } = frame.viewport;
  viewportClone.style.transform = `translate(${x}px, ${y}px) scale(${zoom})`;
  viewportClone.style.transformOrigin = "0 0";
  staging.appendChild(paneClone);
  document.body.appendChild(staging);

  try {
    const dataUrl = await toPng(paneClone, {
      width: frame.width,
      height: frame.height,
      canvasWidth: frame.width,
      canvasHeight: frame.height,
      backgroundColor: flowBackground(flow),
      pixelRatio: 2,
      filter: shouldExportNode,
      skipAutoScale: true,
    });
    downloadDataUrl(dataUrl, args.filename);
  } finally {
    staging.remove();
  }
}

export function downloadMermaid(text: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  const link = document.createElement("a");
  link.download = filename;
  link.href = url;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

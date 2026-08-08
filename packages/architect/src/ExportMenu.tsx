import { useState, type RefObject } from "react";
import { ChevronDown, Clipboard, FileCode2, FileImage } from "lucide-react";
import { useReactFlow } from "@xyflow/react";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@crystal/ui";
import {
  diagramExportFilename,
  downloadMermaid,
  exportReactFlowPng,
} from "./export-png.js";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function afterFullRender(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

export function ExportMenu({
  canvasRef,
  workspace,
  view,
  level,
  mermaid,
  onNotice,
  onRenderAllChange,
}: {
  canvasRef: RefObject<HTMLElement | null>;
  workspace: string;
  view: "architecture" | "codebase" | "infra";
  level?: string | null;
  mermaid?: string | null;
  onNotice: (message: string) => void;
  /** Virtualized canvases must mount off-screen nodes before the pane is cloned. */
  onRenderAllChange?: (renderAll: boolean) => void;
}) {
  const { getNodes, getNodesBounds } = useReactFlow();
  const [busy, setBusy] = useState(false);

  const exportPng = async () => {
    setBusy(true);
    onRenderAllChange?.(true);
    try {
      if (onRenderAllChange) await afterFullRender();
      const root = canvasRef.current;
      if (!root) throw new Error("The diagram canvas is not ready.");
      const nodes = getNodes();
      if (nodes.length === 0) throw new Error("The diagram has no nodes to export.");
      await exportReactFlowPng({
        root,
        nodes,
        bounds: getNodesBounds(nodes),
        filename: diagramExportFilename(workspace, view, level, "png"),
      });
    } catch (error) {
      onNotice(`PNG export failed: ${errorMessage(error)}`);
    } finally {
      onRenderAllChange?.(false);
      setBusy(false);
    }
  };

  const copyMermaid = async () => {
    if (!mermaid) return;
    try {
      await navigator.clipboard.writeText(mermaid);
      onNotice("Mermaid C4 copied to the clipboard.");
    } catch (error) {
      onNotice(`Copy mermaid failed: ${errorMessage(error)}`);
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="h-6 gap-1 px-1.5 text-[11px]" disabled={busy}>
          <FileImage className="h-3.5 w-3.5" />
          {busy ? "Exporting…" : "Export"}
          <ChevronDown className="h-3 w-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => void exportPng()}>
          <FileImage className="h-3.5 w-3.5" /> PNG image
        </DropdownMenuItem>
        {mermaid ? (
          <>
            <DropdownMenuItem
              onSelect={() =>
                downloadMermaid(
                  mermaid,
                  diagramExportFilename(workspace, view, level, "mmd"),
                )
              }
            >
              <FileCode2 className="h-3.5 w-3.5" /> Mermaid C4
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void copyMermaid()}>
              <Clipboard className="h-3.5 w-3.5" /> Copy mermaid
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

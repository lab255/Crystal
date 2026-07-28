import { useCallback } from "react";
import {
  Boxes,
  Copy,
  ExternalLink,
  FlaskConical,
  FolderGit2,
  GitBranch,
  Map as MapIcon,
  Pin,
  PinOff,
  Route,
  ShieldCheck,
  SquareTerminal,
} from "lucide-react";
import {
  formatHighlightSel,
  type ArchitectureGraph,
  type HighlightRef,
} from "@crystal/core";
import type { MenuEntry } from "@crystal/ui";
import type { NavPatch } from "./nav-store.js";
import { requestOpenFile } from "./open-file.js";
import { useNav, useNavUpdate, useWorkspaces } from "./provider.js";

/**
 * The shared function/symbol context menu — "right-click a function" means the
 * same thing everywhere in the IDE. Every view that renders a symbol, file or
 * module (code map chips, system exports, surfaces rows, test cases, coverage
 * paths, flamegraph frames…) composes its view-specific entries on top of this
 * standard block, so the cross-view vocabulary (pin, editor, code map,
 * quality, copy) never drifts between modes.
 *
 * Pure `symbolMenuEntries` does the building (unit-testable); `useSymbolMenu`
 * binds it to the nav store and active workspace.
 */

/** A rendered function/symbol (or file/module) anywhere in the IDE. */
export interface SymbolTarget extends HighlightRef {
  /** 1-based line for the editor jump (declaration, registration, failure…). */
  line?: number;
}

/** Standard groups a view can suppress when it hand-rolls the equivalent. */
export type SymbolMenuGroup = "pin" | "editor" | "codemap" | "quality" | "copy";

export interface SymbolMenuOptions {
  /** Pan/flash the architecture diagram to this ref (canvas-local). */
  revealOnDiagram?: (ref: HighlightRef) => void;
  /** Expand the ref's module/file into live code on the unified canvas. */
  zoomIntoCode?: (ref: HighlightRef) => void;
  /** Seed a dataflow journey at this symbol. */
  startJourney?: (entry: { file: string; symbol: string }) => void;
  /** Open a terminal at the module directory. */
  openTerminal?: (dir: string) => void;
  /** Graph for the hierarchy submenu (ancestor chain of `target.node`). */
  graph?: ArchitectureGraph | null;
  /** Editor-jump override (e.g. the code map switches workspaces first). */
  openFile?: (file: string, line?: number) => void;
  /** Suppress standard groups the view hand-rolls. */
  omit?: readonly SymbolMenuGroup[];
}

/** What the builder needs from the app; `useSymbolMenu` supplies it. */
export interface SymbolMenuContext {
  nav: (patch: NavPatch) => void;
  /** Active workspace id — code-map drills are workspace-scoped. */
  ws: string | null;
  /** Currently pinned `architect.sel`, for the pin/unpin toggle. */
  pinnedSel: string | null | undefined;
}

const TEST_FILE_RE = /\.(test|spec)\.[cm]?[jt]sx?$/;

const basename = (path: string): string => path.split("/").pop() ?? path;

/** Build the standard cross-view block for one target. Pure. */
export function symbolMenuEntries(
  target: SymbolTarget,
  ctx: SymbolMenuContext,
  options: SymbolMenuOptions = {},
): MenuEntry[] {
  const omit = new Set(options.omit ?? []);
  const entries: MenuEntry[] = [];
  const { file, line, module, symbol } = target;
  const sel = formatHighlightSel(target);

  if (!omit.has("pin") && sel) {
    entries.push(
      ctx.pinnedSel === sel
        ? {
            type: "item",
            label: "Unpin highlight",
            icon: PinOff,
            onSelect: () => ctx.nav({ architect: { sel: null } }),
          }
        : {
            type: "item",
            label: "Pin highlight",
            icon: Pin,
            hint: "sel in URL",
            onSelect: () => ctx.nav({ architect: { sel } }),
          },
    );
  }

  if (!omit.has("editor") && file) {
    const open = options.openFile ?? requestOpenFile;
    entries.push({
      type: "item",
      label: "Open in editor",
      icon: ExternalLink,
      hint: line != null ? `${basename(file)}:${line}` : basename(file),
      onSelect: () => open(file, line),
    });
  }

  if (!omit.has("codemap") && (file || module) && ctx.ws) {
    const ws = ctx.ws;
    entries.push({
      type: "item",
      label: "Show in code map",
      icon: FolderGit2,
      onSelect: () =>
        ctx.nav({
          mode: "architect",
          architect: {
            view: "codebase",
            codemap: file
              ? { kind: "file", ws, path: file }
              : { kind: "module", ws, path: module! },
            ...(sel ? { sel } : {}),
          },
        }),
    });
  }

  if (options.revealOnDiagram) {
    const reveal = options.revealOnDiagram;
    entries.push({
      type: "item",
      label: "Show on architecture diagram",
      icon: Boxes,
      onSelect: () => reveal(target),
    });
  }
  if (options.zoomIntoCode && (module || file)) {
    const zoom = options.zoomIntoCode;
    entries.push({
      type: "item",
      label: "Zoom into code",
      icon: MapIcon,
      hint: file ?? module,
      onSelect: () => zoom(target),
    });
  }
  if (options.startJourney && file && symbol) {
    const start = options.startJourney;
    const entry = { file, symbol };
    entries.push({
      type: "item",
      label: "Start journey here",
      icon: Route,
      onSelect: () => start(entry),
    });
  }
  if (options.openTerminal && module) {
    const open = options.openTerminal;
    const dir = module;
    entries.push({
      type: "item",
      label: "Open terminal at module",
      icon: SquareTerminal,
      hint: dir,
      onSelect: () => open(dir),
    });
  }

  if (!omit.has("quality") && file) {
    entries.push(
      TEST_FILE_RE.test(file)
        ? {
            type: "item",
            label: "Show in test runner",
            icon: FlaskConical,
            onSelect: () => ctx.nav({ mode: "quality", quality: { view: "tests", file } }),
          }
        : {
            type: "item",
            label: "Show coverage",
            icon: ShieldCheck,
            onSelect: () =>
              ctx.nav({ mode: "quality", quality: { view: "coverage", covPath: file } }),
          },
    );
  }

  if (!omit.has("copy") && (file || module)) {
    if (entries.length) entries.push({ type: "separator" });
    entries.push({
      type: "item",
      label: symbol && file ? "Copy reference" : "Copy path",
      icon: Copy,
      hint: symbol && file ? `${basename(file)}#${symbol}` : undefined,
      onSelect: () =>
        void navigator.clipboard?.writeText(symbol && file ? `${file}#${symbol}` : (file ?? module!)),
    });
  }

  // Containment chain — traverse up the diagram hierarchy from here.
  if (options.graph && target.node && target.nodePath?.length) {
    const byId = new Map(options.graph.nodes.map((n) => [n.id, n]));
    const chain = target.nodePath
      .map((id) => byId.get(id))
      .filter((n): n is NonNullable<typeof n> => n != null);
    if (chain.length) {
      const reveal = options.revealOnDiagram;
      entries.push({
        type: "submenu",
        label: "Hierarchy",
        icon: GitBranch,
        entries: chain.map((n) => ({
          type: "item" as const,
          label: n.label,
          hint: n.kind,
          onSelect: () => {
            const ref: HighlightRef = { node: n.id, label: n.label };
            if (reveal) reveal(ref);
            else {
              const nodeSel = formatHighlightSel(ref);
              if (nodeSel) ctx.nav({ architect: { sel: nodeSel } });
            }
          },
        })),
      });
    }
  }

  return entries;
}

/**
 * Bind `symbolMenuEntries` to the app: nav store, active workspace and the
 * current pinned selection. Returns a stable builder for render-time use.
 */
export function useSymbolMenu(): (
  target: SymbolTarget,
  options?: SymbolMenuOptions,
) => MenuEntry[] {
  const nav = useNavUpdate();
  const ws = useWorkspaces((s) => s.activeId);
  const pinnedSel = useNav((l) => l.architect?.sel);
  return useCallback(
    (target, options) => symbolMenuEntries(target, { nav, ws, pinnedSel }, options),
    [nav, ws, pinnedSel],
  );
}

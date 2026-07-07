import { useCallback, useMemo } from "react";
import {
  formatHighlightSel,
  parseHighlightSel,
  type ArchitectureGraph,
  type HighlightRef,
} from "@crystal/core";
import { useHighlight, useHighlightUpdate, useNav, useNavUpdate } from "@crystal/client";
import {
  Copy,
  FolderGit2,
  GitBranch,
  Landmark,
  Map as MapIcon,
  Pin,
  PinOff,
  Route,
  SquareTerminal,
} from "lucide-react";
import type { MenuEntry } from "@crystal/ui";

/**
 * Cross-view highlight, architect side. One shared identity (`HighlightRef`
 * in `@crystal/core`) with two lifetimes:
 *
 *   hover  — published to the client highlight store on mouseover; every
 *            surface lights up matching elements live.
 *   pinned — a click, stored as `architect.sel` in the deep link; persistent,
 *            shareable, restored on reload.
 *
 * Views call `useViewHighlight(viewId)` and match their elements with
 * `matchHighlight`; `hlClass` turns matches into the shared css classes
 * (architect.css). `highlightAttrs` stamps the structured hierarchy onto the
 * DOM so selectors, tests and devtools can traverse it.
 */
export function useViewHighlight(view: string): {
  /** Live hover from any surface (including this one — check `hoverSource`). */
  hover: HighlightRef | null;
  /** View id that published the current hover. */
  hoverSource: string | null;
  /** Deep-linked pinned highlight (`sel` param), if any. */
  pinned: HighlightRef | null;
  /** Publish (`ref`) or clear (`null`) this view's hover. */
  setHover: (ref: HighlightRef | null) => void;
  /** Pin a highlight into the deep link, or clear it with `null`. */
  pin: (ref: HighlightRef | null) => void;
} {
  const hover = useHighlight((s) => s.hover);
  const hoverSource = useHighlight((s) => s.source);
  const publish = useHighlightUpdate();
  const sel = useNav((l) => l.architect?.sel);
  const updateNav = useNavUpdate();

  const pinned = useMemo(() => parseHighlightSel(sel), [sel]);
  const setHover = useCallback(
    (ref: HighlightRef | null) => publish(ref, view),
    [publish, view],
  );
  const pin = useCallback(
    (ref: HighlightRef | null) => {
      updateNav({ architect: { sel: ref ? formatHighlightSel(ref) : null } });
    },
    [updateNav],
  );

  return { hover, hoverSource, pinned, setHover, pin };
}

/** Combine hover/pin match results into the shared highlight css classes. */
export function hlClass(
  hover: "exact" | "kin" | null,
  pinned: "exact" | "kin" | null,
): string {
  const parts: string[] = [];
  if (hover === "exact") parts.push("hl-hover");
  else if (hover === "kin") parts.push("hl-kin");
  if (pinned === "exact") parts.push("hl-pin");
  else if (pinned === "kin" && hover === null) parts.push("hl-kin");
  return parts.join(" ");
}

/**
 * Structured hierarchy annotation for a rendered element: every facet of its
 * identity plus its containment chain, as data attributes. This is the DOM
 * face of the highlight system — stable hooks for css, tests and tooling.
 */
export function highlightAttrs(ref: HighlightRef): Record<string, string> {
  const attrs: Record<string, string> = {};
  if (ref.node) attrs["data-hl-node"] = ref.node;
  if (ref.nodePath?.length) attrs["data-hl-node-path"] = ref.nodePath.join("/");
  if (ref.module) attrs["data-hl-module"] = ref.module;
  if (ref.file) attrs["data-hl-file"] = ref.file;
  if (ref.symbol) attrs["data-hl-symbol"] = ref.symbol;
  return attrs;
}

/** What a surface can do with a highlight — each view passes what it has. */
export interface CrossViewActions {
  /** Graph for hierarchy labels (ancestor chain in the submenu). */
  graph?: ArchitectureGraph | null;
  /** Pan/flash the diagram to a node (canvas) or request it (panels). */
  revealOnDiagram?: (ref: HighlightRef) => void;
  /** Drill the code map to the ref's module/file. */
  openInCodeMap?: (ref: HighlightRef) => void;
  /** Open the file in the editor mode. */
  openFile?: (file: string) => void;
  /** Seed a journey at this symbol. */
  startJourney?: (entry: { file: string; symbol: string }) => void;
  /** Open a terminal at the module directory. */
  openTerminal?: (dir: string) => void;
  /** Pin/unpin (from `useViewHighlight`). */
  pin?: (ref: HighlightRef | null) => void;
  /** Currently pinned ref, to offer unpin. */
  pinned?: HighlightRef | null;
}

/**
 * Context-menu entries for traversing the IDE from any highlighted element.
 * Shared by the canvas, code map, flamegraph, call profile and journey steps
 * so “right-click a component” means the same everywhere.
 */
export function crossViewEntries(ref: HighlightRef, actions: CrossViewActions): MenuEntry[] {
  const entries: MenuEntry[] = [];
  const sameSel = (a: HighlightRef | null | undefined, b: HighlightRef): boolean =>
    !!a && formatHighlightSel(a) === formatHighlightSel(b);

  if (actions.pin) {
    const pin = actions.pin;
    entries.push(
      sameSel(actions.pinned, ref)
        ? { type: "item", label: "Unpin highlight", icon: PinOff, onSelect: () => pin(null) }
        : {
            type: "item",
            label: "Pin highlight",
            icon: Pin,
            hint: "sel in URL",
            onSelect: () => pin(ref),
          },
    );
  }
  if (actions.revealOnDiagram) {
    const reveal = actions.revealOnDiagram;
    entries.push({
      type: "item",
      label: "Reveal on diagram",
      icon: Landmark,
      onSelect: () => reveal(ref),
    });
  }
  if (actions.openInCodeMap && (ref.module || ref.file)) {
    const open = actions.openInCodeMap;
    entries.push({
      type: "item",
      label: "Open in code map",
      icon: MapIcon,
      hint: ref.file ?? ref.module,
      onSelect: () => open(ref),
    });
  }
  if (actions.openFile && ref.file) {
    const open = actions.openFile;
    const file = ref.file;
    entries.push({
      type: "item",
      label: "Open file in editor",
      icon: FolderGit2,
      onSelect: () => open(file),
    });
  }
  if (actions.startJourney && ref.file && ref.symbol) {
    const start = actions.startJourney;
    const entry = { file: ref.file, symbol: ref.symbol };
    entries.push({
      type: "item",
      label: "Start journey here",
      icon: Route,
      onSelect: () => start(entry),
    });
  }
  if (actions.openTerminal && ref.module) {
    const open = actions.openTerminal;
    const dir = ref.module;
    entries.push({
      type: "item",
      label: "Open terminal at module",
      icon: SquareTerminal,
      hint: dir,
      onSelect: () => open(dir),
    });
  }
  const copyable = ref.file ?? ref.module;
  if (copyable) {
    entries.push({
      type: "item",
      label: ref.symbol && ref.file ? "Copy file#symbol" : "Copy path",
      icon: Copy,
      onSelect: () => {
        void navigator.clipboard?.writeText(ref.symbol && ref.file ? `${ref.file}#${ref.symbol}` : copyable);
      },
    });
  }

  // Containment chain — traverse up the hierarchy from here.
  if (actions.graph && ref.node && ref.nodePath?.length) {
    const byId = new Map(actions.graph.nodes.map((n) => [n.id, n]));
    const chain = ref.nodePath
      .map((id) => byId.get(id))
      .filter((n): n is NonNullable<typeof n> => n != null);
    if (chain.length) {
      const reveal = actions.revealOnDiagram;
      const pin = actions.pin;
      entries.push({
        type: "submenu",
        label: "Hierarchy",
        icon: GitBranch,
        entries: chain.map((n) => ({
          type: "item" as const,
          label: n.label,
          hint: n.kind,
          onSelect: () => {
            const target: HighlightRef = { node: n.id, label: n.label };
            if (reveal) reveal(target);
            else pin?.(target);
          },
        })),
      });
    }
  }
  return entries;
}

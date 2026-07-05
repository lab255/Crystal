import { initVimMode, VimMode, type VimAdapterInstance } from "monaco-vim";
import { monaco } from "./monaco-setup.js";

/** monaco-vim attaches the CodeMirror Vim API at runtime; its types omit it. */
const VimApi = VimMode as unknown as {
  Vim: { defineEx(name: string, prefix: string, handler: () => void): void };
};

export type KeymapProfile = "vscode" | "intellij" | "vim";

export const KEYMAP_LABELS: Record<KeymapProfile, string> = {
  vscode: "VS Code",
  intellij: "IntelliJ",
  vim: "Vim",
};

export interface KeymapHandle {
  dispose(): void;
}

/**
 * Apply a keybinding profile to a Monaco editor instance.
 * - vscode: Monaco defaults.
 * - intellij: IDEA-style bindings layered on top of the defaults.
 * - vim: modal editing via monaco-vim (`:w` saves).
 */
export function applyKeymap(
  editor: import("monaco-editor").editor.IStandaloneCodeEditor,
  profile: KeymapProfile,
  hooks: { onSave: () => void; statusBar?: HTMLElement | null },
): KeymapHandle {
  const disposables: { dispose(): void }[] = [];

  if (profile === "vim") {
    VimApi.Vim.defineEx("write", "w", hooks.onSave);
    const vim: VimAdapterInstance = initVimMode(editor, hooks.statusBar ?? undefined);
    disposables.push(vim);
  }

  if (profile === "intellij") {
    const bind = (keybinding: number, handler: () => void) => {
      disposables.push(
        editor.addAction({
          id: `crystal.intellij.${keybinding}`,
          label: "IntelliJ binding",
          keybindings: [keybinding],
          run: handler,
        }),
      );
    };
    const run = (actionId: string) => () => editor.trigger("intellij-keymap", actionId, null);

    // Ctrl+Y — delete line
    bind(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyY, run("editor.action.deleteLines"));
    // Ctrl+D — duplicate line/selection
    bind(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyD, run("editor.action.copyLinesDownAction"));
    // Ctrl+W / Ctrl+Shift+W — expand / shrink selection
    bind(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyW, run("editor.action.smartSelect.expand"));
    bind(
      monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyW,
      run("editor.action.smartSelect.shrink"),
    );
    // Ctrl+Shift+Up/Down — move line
    bind(
      monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.UpArrow,
      run("editor.action.moveLinesUpAction"),
    );
    bind(
      monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.DownArrow,
      run("editor.action.moveLinesDownAction"),
    );
    // Ctrl+Alt+L — format document
    bind(
      monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyL,
      run("editor.action.formatDocument"),
    );
    // Ctrl+G — go to line
    bind(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyG, run("editor.action.gotoLine"));
    // Alt+F7 — find usages → references
    bind(monaco.KeyCode.F7 | monaco.KeyMod.Alt, run("editor.action.referenceSearch.trigger"));
  }

  // Ctrl+S everywhere (vim also gets :w above).
  disposables.push(
    editor.addAction({
      id: "crystal.save",
      label: "Save file",
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
      run: hooks.onSave,
    }),
  );

  return {
    dispose() {
      for (const d of disposables) d.dispose();
    },
  };
}

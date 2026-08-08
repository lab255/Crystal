import { describe, expect, it } from "vitest";
import { CRYSTAL_MODES, MODE_LABELS, modeShortcutDigit } from "./modes.js";
import {
  MODE_SHORTCUTS,
  SHELL_SHORTCUTS,
  matchesShortcut,
  shortcutCheatSheetGroups,
  shortcutHint,
  workspaceShortcutHint,
  type ShortcutEvent,
} from "./shortcuts.js";

function key(
  value: string,
  modifiers: Partial<Omit<ShortcutEvent, "key">> = {},
): ShortcutEvent {
  return {
    key: value,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...modifiers,
  };
}

describe("shell shortcut tables", () => {
  it("derives every mode row and binding from the mode registry", () => {
    expect(
      MODE_SHORTCUTS.map((binding) => ({
        mode: binding.mode,
        label: binding.label,
        hint: shortcutHint(binding),
      })),
    ).toEqual(
      CRYSTAL_MODES.map((mode) => ({
        mode,
        label: MODE_LABELS[mode],
        hint: `Ctrl+${modeShortcutDigit(mode)}`,
      })),
    );
  });

  it("uses the handler bindings as the cheat-sheet source", () => {
    const shellRows = shortcutCheatSheetGroups().find((group) => group.label === "Shell")!.rows;
    expect(shellRows).toContainEqual({
      id: SHELL_SHORTCUTS.palette.id,
      label: SHELL_SHORTCUTS.palette.label,
      hint: "Ctrl+Shift+P / Ctrl+K",
    });
    expect(shellRows).toContainEqual({
      id: SHELL_SHORTCUTS.workspaces.id,
      label: SHELL_SHORTCUTS.workspaces.label,
      hint: "Ctrl+Alt+1–9",
    });
    expect(shellRows).toContainEqual({
      id: SHELL_SHORTCUTS.cheatSheet.id,
      label: SHELL_SHORTCUTS.cheatSheet.label,
      hint: "Shift+/",
    });
  });

  it("matches both Ctrl and Cmd while keeping modifiers narrow", () => {
    expect(matchesShortcut(key("k", { ctrlKey: true }), SHELL_SHORTCUTS.palette)).toBe(true);
    expect(matchesShortcut(key("K", { metaKey: true }), SHELL_SHORTCUTS.palette)).toBe(true);
    expect(
      matchesShortcut(key("k", { ctrlKey: true, shiftKey: true }), SHELL_SHORTCUTS.palette),
    ).toBe(false);
    expect(
      matchesShortcut(
        key("?", { code: "Slash", shiftKey: true }),
        SHELL_SHORTCUTS.cheatSheet,
      ),
    ).toBe(true);
    expect(matchesShortcut(key("/", { code: "Slash" }), SHELL_SHORTCUTS.cheatSheet)).toBe(false);
  });

  it("derives numbered workspace hints from the same digit range", () => {
    expect(workspaceShortcutHint(0)).toBe("Ctrl+Alt+1");
    expect(workspaceShortcutHint(8)).toBe("Ctrl+Alt+9");
    expect(workspaceShortcutHint(9)).toBeUndefined();
  });
});

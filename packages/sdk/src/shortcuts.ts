import { CRYSTAL_MODES, MODE_LABELS, modeShortcutDigit, type CrystalMode } from "./modes.js";

export interface ShortcutEvent {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

interface ShortcutChord {
  key: string;
  alternateKeys?: readonly string[];
  code?: string;
  keys?: readonly string[];
  mod?: boolean;
  alt?: boolean;
  shift?: boolean;
}

export interface ShellShortcutBinding {
  id: string;
  label: string;
  chords: readonly ShortcutChord[];
}

const DIGIT_KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;

export const SHELL_SHORTCUTS = {
  palette: {
    id: "palette",
    label: "Command palette",
    chords: [
      { key: "p", mod: true, shift: true },
      { key: "k", mod: true },
    ],
  },
  git: {
    id: "git",
    label: "Git tree & log",
    chords: [{ key: "g", mod: true, shift: true }],
  },
  workspaces: {
    id: "workspaces",
    label: "Switch workspace",
    chords: [{ key: "1", keys: DIGIT_KEYS, mod: true, alt: true }],
  },
  terminal: {
    id: "terminal",
    label: "Toggle terminal panel",
    chords: [{ key: "`", mod: true }],
  },
  copyLink: {
    id: "copy-link",
    label: "Copy link to this view",
    chords: [{ key: "l", mod: true }],
  },
  historyBack: {
    id: "history-back",
    label: "Back",
    chords: [{ key: "[", mod: true }],
  },
  historyForward: {
    id: "history-forward",
    label: "Forward",
    chords: [{ key: "]", mod: true }],
  },
  cheatSheet: {
    id: "cheat-sheet",
    label: "Keyboard shortcuts",
    chords: [{ key: "/", alternateKeys: ["?"], code: "Slash", shift: true }],
  },
} as const satisfies Record<string, ShellShortcutBinding>;

export const MODE_SHORTCUTS: ReadonlyArray<ShellShortcutBinding & { mode: CrystalMode }> =
  CRYSTAL_MODES.map((mode) => ({
    id: `mode.${mode}`,
    label: MODE_LABELS[mode],
    mode,
    chords: [{ key: String(modeShortcutDigit(mode)), mod: true }],
  }));

function normalizedKey(key: string): string {
  return key.length === 1 ? key.toLowerCase() : key;
}

function matchesChord(event: ShortcutEvent, chord: ShortcutChord): boolean {
  const mod = event.ctrlKey || event.metaKey;
  if (mod !== (chord.mod ?? false)) return false;
  if (event.altKey !== (chord.alt ?? false)) return false;
  if (event.shiftKey !== (chord.shift ?? false)) return false;

  const eventKey = normalizedKey(event.key);
  const keys = chord.keys ?? [chord.key, ...(chord.alternateKeys ?? [])];
  return (
    keys.some((key) => normalizedKey(key) === eventKey) ||
    (chord.code !== undefined && event.code === chord.code)
  );
}

export function matchesShortcut(
  event: ShortcutEvent,
  binding: ShellShortcutBinding,
): boolean {
  return binding.chords.some((chord) => matchesChord(event, chord));
}

function chordHint(chord: ShortcutChord): string {
  const parts: string[] = [];
  if (chord.mod) parts.push("Ctrl");
  if (chord.alt) parts.push("Alt");
  if (chord.shift) parts.push("Shift");
  const key = chord.keys
    ? `${chord.keys[0]}–${chord.keys[chord.keys.length - 1]}`
    : /^[a-z]$/.test(chord.key)
      ? chord.key.toUpperCase()
      : chord.key;
  parts.push(key);
  return parts.join("+");
}

export function shortcutHint(binding: ShellShortcutBinding): string {
  return binding.chords.map(chordHint).join(" / ");
}

export function workspaceShortcutHint(index: number): string | undefined {
  const chord = SHELL_SHORTCUTS.workspaces.chords[0];
  const key = chord.keys?.[index];
  if (!key) return undefined;
  return chordHint({ ...chord, key, keys: undefined });
}

export interface ShortcutCheatSheetGroup {
  label: string;
  rows: ReadonlyArray<{ id: string; label: string; hint: string }>;
}

function row(binding: ShellShortcutBinding) {
  return { id: binding.id, label: binding.label, hint: shortcutHint(binding) };
}

export function shortcutCheatSheetGroups(): ShortcutCheatSheetGroup[] {
  return [
    {
      label: "Modes",
      rows: MODE_SHORTCUTS.map(row),
    },
    {
      label: "Shell",
      rows: [
        SHELL_SHORTCUTS.palette,
        SHELL_SHORTCUTS.cheatSheet,
        SHELL_SHORTCUTS.workspaces,
        SHELL_SHORTCUTS.git,
        SHELL_SHORTCUTS.terminal,
        SHELL_SHORTCUTS.copyLink,
        SHELL_SHORTCUTS.historyBack,
        SHELL_SHORTCUTS.historyForward,
      ].map(row),
    },
  ];
}

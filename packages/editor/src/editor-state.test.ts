import { describe, expect, it, vi } from "vitest";
import {
  bufferFromRead,
  canCloseBuffer,
  canSaveBuffer,
  hasDirtyBuffers,
  isDirty,
  isWriteConflict,
  reduceBuffers,
  sha256Text,
  shouldCloseFromShortcut,
  writeRequestFor,
  type EditorBuffer,
} from "./editor-state.js";

function buffer(patch: Partial<EditorBuffer> = {}): EditorBuffer {
  return {
    path: "src/app.ts",
    content: "saved\n",
    savedContent: "saved\n",
    truncated: false,
    sha: "sha-old",
    conflicted: false,
    ...patch,
  };
}

describe("editor buffer safety", () => {
  it("detects dirty buffers and confirms only before discarding one", () => {
    const confirmDiscard = vi.fn(() => false);
    const clean = buffer();
    const dirty = buffer({ content: "edited\n" });

    expect(isDirty(clean)).toBe(false);
    expect(isDirty(dirty)).toBe(true);
    expect(hasDirtyBuffers([clean, dirty])).toBe(true);
    expect(canCloseBuffer(clean, confirmDiscard)).toBe(true);
    expect(confirmDiscard).not.toHaveBeenCalled();
    expect(canCloseBuffer(dirty, confirmDiscard)).toBe(false);
    expect(confirmDiscard).toHaveBeenCalledWith("Discard unsaved changes to src/app.ts?");

    confirmDiscard.mockReturnValue(true);
    expect(canCloseBuffer(dirty, confirmDiscard)).toBe(true);
  });

  it("makes truncated buffers neither editable nor saveable", () => {
    const truncated = buffer({ truncated: true });
    const buffers = [truncated];
    const next = reduceBuffers(buffers, {
      type: "edit",
      path: truncated.path,
      content: "replacement\n",
    });

    expect(next).toBe(buffers);
    expect(next[0]).toBe(truncated);
    expect(canSaveBuffer(truncated)).toBe(false);
  });

  it("guards ordinary writes with the read sha and omits it only for explicit overwrite", () => {
    const dirty = buffer({ content: "my edit\n" });

    expect(writeRequestFor(dirty, false)).toEqual({
      path: "src/app.ts",
      content: "my edit\n",
      baseSha: "sha-old",
    });
    expect(writeRequestFor(dirty, true)).toEqual({
      path: "src/app.ts",
      content: "my edit\n",
    });
  });

  it("reloads a clean changed buffer with its new sha", () => {
    const original = buffer();
    const next = reduceBuffers([original], {
      type: "disk-reloaded",
      path: original.path,
      expectedSha: "sha-old",
      read: { content: "from disk\n", truncated: false, sha: "sha-new" },
    });

    expect(next[0]).toEqual(
      bufferFromRead(original.path, {
        content: "from disk\n",
        truncated: false,
        sha: "sha-new",
      }),
    );
  });

  it("preserves edits made while a disk reload is in flight and marks a conflict", () => {
    const original = buffer();
    const edited = reduceBuffers([original], {
      type: "edit",
      path: original.path,
      content: "my edit\n",
    });
    const next = reduceBuffers(edited, {
      type: "disk-reloaded",
      path: original.path,
      expectedSha: "sha-old",
      read: { content: "agent edit\n", truncated: false, sha: "sha-agent" },
    });

    expect(next[0]).toMatchObject({
      content: "my edit\n",
      savedContent: "saved\n",
      sha: "sha-old",
      conflicted: true,
    });
  });

  it("marks dirty external changes without replacing the buffer", () => {
    const dirty = buffer({ content: "my edit\n" });
    const next = reduceBuffers([dirty], { type: "disk-changed", path: dirty.path });

    expect(next[0]).toEqual({ ...dirty, conflicted: true });
  });

  it("reload-discard replaces conflicted edits with the complete disk baseline", () => {
    const dirty = buffer({ content: "my edit\n", conflicted: true });
    const next = reduceBuffers([dirty], {
      type: "reload-discarded",
      path: dirty.path,
      read: { content: "agent edit\n", truncated: false, sha: "sha-agent" },
    });

    expect(next[0]).toEqual(
      bufferFromRead(dirty.path, {
        content: "agent edit\n",
        truncated: false,
        sha: "sha-agent",
      }),
    );
  });

  it("advances the saved baseline and sha without losing edits typed during a save", () => {
    const editing = buffer({ content: "newer edit\n" });
    const next = reduceBuffers([editing], {
      type: "save-succeeded",
      path: editing.path,
      content: "submitted edit\n",
      sha: "sha-submitted",
    });

    expect(next[0]).toMatchObject({
      content: "newer edit\n",
      savedContent: "submitted edit\n",
      sha: "sha-submitted",
      conflicted: false,
    });
    expect(isDirty(next[0]!)).toBe(true);
  });

  it("keeps conflict error classification deliberately narrow", () => {
    expect(
      isWriteConflict(
        new Error(
          "Conflict: src/app.ts changed on disk since it was loaded \u2014 reload before saving",
        ),
      ),
    ).toBe(true);
    expect(isWriteConflict(new Error("Conflict while saving src/app.ts"))).toBe(false);
    expect(isWriteConflict("Conflict: src/app.ts changed on disk")).toBe(false);
  });

  it("matches the server's UTF-8 sha256 bookkeeping", async () => {
    await expect(sha256Text("hello")).resolves.toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });

  it("lets IntelliJ expand selection own Cmd+W only while Monaco is focused", () => {
    expect(
      shouldCloseFromShortcut({ visible: true, keymap: "intellij", editorFocused: true }),
    ).toBe(false);
    expect(
      shouldCloseFromShortcut({ visible: true, keymap: "intellij", editorFocused: false }),
    ).toBe(true);
    expect(
      shouldCloseFromShortcut({ visible: false, keymap: "vscode", editorFocused: true }),
    ).toBe(false);
  });
});

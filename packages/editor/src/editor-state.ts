export interface FileRead {
  content: string;
  truncated: boolean;
  sha: string;
}

export interface EditorBuffer extends FileRead {
  path: string;
  savedContent: string;
  conflicted: boolean;
}

export type BufferAction =
  | { type: "edit"; path: string; content: string }
  | { type: "disk-changed"; path: string }
  | { type: "disk-reloaded"; path: string; expectedSha: string; read: FileRead }
  | { type: "reload-discarded"; path: string; read: FileRead }
  | { type: "save-succeeded"; path: string; content: string; sha: string }
  | { type: "save-conflicted"; path: string };

export function bufferFromRead(path: string, read: FileRead): EditorBuffer {
  return {
    path,
    ...read,
    savedContent: read.content,
    conflicted: false,
  };
}

export function isDirty(buffer: Pick<EditorBuffer, "content" | "savedContent">): boolean {
  return buffer.content !== buffer.savedContent;
}

export function hasDirtyBuffers(
  buffers: readonly Pick<EditorBuffer, "content" | "savedContent">[],
): boolean {
  return buffers.some(isDirty);
}

export function canCloseBuffer(
  buffer: EditorBuffer,
  confirmDiscard: (message: string) => boolean,
): boolean {
  return !isDirty(buffer) || confirmDiscard(`Discard unsaved changes to ${buffer.path}?`);
}

export function canSaveBuffer(buffer: EditorBuffer): boolean {
  return !buffer.truncated;
}

export function writeRequestFor(
  buffer: EditorBuffer,
  overwrite: boolean,
): { path: string; content: string; baseSha?: string } {
  const request = { path: buffer.path, content: buffer.content };
  return overwrite ? request : { ...request, baseSha: buffer.sha };
}

export function shouldCloseFromShortcut({
  visible,
  keymap,
  editorFocused,
}: {
  visible: boolean;
  keymap: "vscode" | "intellij" | "vim";
  editorFocused: boolean;
}): boolean {
  return visible && !(keymap === "intellij" && editorFocused);
}

export function isWriteConflict(error: unknown): boolean {
  return (
    error instanceof Error &&
    /^Conflict: .+ changed on disk since it was loaded \u2014 reload before saving$/.test(
      error.message,
    )
  );
}

export async function sha256Text(content: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(content),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

export function reduceBuffers(
  buffers: EditorBuffer[],
  action: BufferAction,
): EditorBuffer[] {
  const index = buffers.findIndex((buffer) => buffer.path === action.path);
  if (index === -1) return buffers;

  const current = buffers[index]!;
  let next = current;
  switch (action.type) {
    case "edit":
      if (!current.truncated && current.content !== action.content) {
        next = { ...current, content: action.content };
      }
      break;
    case "disk-changed":
      if (isDirty(current) && !current.conflicted) next = { ...current, conflicted: true };
      break;
    case "disk-reloaded":
      if (current.sha !== action.expectedSha) break;
      next = isDirty(current)
        ? { ...current, conflicted: true }
        : bufferFromRead(current.path, action.read);
      break;
    case "reload-discarded":
      next = bufferFromRead(current.path, action.read);
      break;
    case "save-succeeded":
      next = {
        ...current,
        savedContent: action.content,
        sha: action.sha,
        conflicted: false,
      };
      break;
    case "save-conflicted":
      if (!current.conflicted) next = { ...current, conflicted: true };
      break;
  }

  if (next === current) return buffers;
  const result = [...buffers];
  result[index] = next;
  return result;
}

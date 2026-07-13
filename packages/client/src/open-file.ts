/**
 * Cross-mode "open this file in the editor" request. The SDK shell listens for
 * the event, switches to the code mode and hands the path (plus optional line)
 * to the editor — see CrystalShell's `crystal:open-file` listener. Living in
 * @crystal/client keeps every mode able to link into the editor without
 * depending on another mode package.
 */
export function requestOpenFile(path: string, line?: number): void {
  window.dispatchEvent(new CustomEvent("crystal:open-file", { detail: { path, line } }));
}

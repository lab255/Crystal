/**
 * Terminal model.
 *
 * The bridge server hosts line-mode terminals per workspace: a persistent
 * shell process with piped stdio (no PTY — full-screen TUIs won't render, but
 * builds, tests, git and dev servers work). Output streams to clients as
 * sequenced chunks; a capped replay buffer lets late joiners catch up.
 */

export type TerminalStatus = "running" | "exited";

export interface TerminalInfo {
  id: string;
  /** Working directory relative to the workspace root. */
  cwd: string;
  /** Shell binary the terminal runs. */
  shell: string;
  status: TerminalStatus;
  exitCode: number | null;
  createdAt: string;
}

/** Where a chunk came from; `input` echoes what the user sent for transcript feel. */
export type TerminalStream = "stdout" | "stderr" | "input" | "system";

export interface TerminalChunk {
  terminalId: string;
  /** Monotonic within a terminal — clients dedupe replay vs live by seq. */
  seq: number;
  stream: TerminalStream;
  text: string;
}

/**
 * Terminal model.
 *
 * The bridge server hosts PTY-backed terminals per workspace (ConPTY on
 * Windows, forkpty elsewhere): child programs see a real TTY, so interactive
 * CLIs, TUIs, colors and prompts all work. Output streams to clients as
 * sequenced chunks of raw terminal bytes (ANSI included — render with an
 * xterm-compatible emulator); a capped replay buffer lets late joiners catch
 * up. Every connected client shares the same live session: all of them
 * receive the output stream and any of them may write input or resize.
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
  /** Current PTY size — late joiners size their emulator to match. */
  cols: number;
  rows: number;
}

/**
 * Where a chunk came from. PTY terminals emit `stdout` (stdout+stderr merged,
 * input echoed by the PTY itself) and `system` (server-side notices such as
 * exit). `stderr`/`input` remain for client-local agent-console transcripts.
 */
export type TerminalStream = "stdout" | "stderr" | "input" | "system";

export interface TerminalChunk {
  terminalId: string;
  /** Monotonic within a terminal — clients dedupe replay vs live by seq. */
  seq: number;
  stream: TerminalStream;
  text: string;
}

import { spawn as spawnProcess } from "node:child_process";
import { spawn as spawnPty, type IPty } from "@lydell/node-pty";
import {
  Emitter,
  nowIso,
  uid,
  type TerminalChunk,
  type TerminalInfo,
  type TerminalStream,
} from "@crystal/core";
import { resolveInRoot, toRelPath } from "./paths.js";

/** Replay buffer cap per terminal — enough scrollback without unbounded memory. */
const MAX_BUFFER_CHUNKS = 2000;

const DEFAULT_COLS = 100;
const DEFAULT_ROWS = 30;
const MIN_DIM = 2;
const MAX_DIM = 500;

interface TerminalRecord {
  info: TerminalInfo;
  pty: IPty | null;
  chunks: TerminalChunk[];
  seq: number;
}

function defaultShell(): string {
  return process.platform === "win32"
    ? (process.env.ComSpec ?? "cmd.exe")
    : (process.env.SHELL ?? "/bin/bash");
}

function clampDim(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(MAX_DIM, Math.max(MIN_DIM, Math.floor(value as number)));
}

/**
 * PTY terminals for one workspace: a persistent shell per terminal running on
 * a real pseudo-terminal (ConPTY on Windows), so interactive CLIs and TUIs
 * work. Raw output (ANSI included, input echoed by the PTY) is buffered for
 * replay and emitted as sequenced chunks; exited terminals stay listed
 * (scrollback intact) until killed. The session is shared: every bridge
 * client receives the same stream and any of them may write or resize.
 */
export class TerminalManager {
  readonly events = new Emitter<{
    data: { chunk: TerminalChunk };
    changed: { terminal: TerminalInfo };
  }>();

  private terminals = new Map<string, TerminalRecord>();

  constructor(private readonly root: string) {}

  list(): TerminalInfo[] {
    return [...this.terminals.values()].map((r) => ({ ...r.info }));
  }

  create(cwd = ".", cols?: number, rows?: number): TerminalInfo {
    const cwdAbs = resolveInRoot(this.root, cwd);
    const shell = defaultShell();
    const info: TerminalInfo = {
      id: uid("term"),
      cwd: toRelPath(this.root, cwdAbs) || ".",
      shell,
      status: "running",
      exitCode: null,
      createdAt: nowIso(),
      cols: clampDim(cols, DEFAULT_COLS),
      rows: clampDim(rows, DEFAULT_ROWS),
    };
    const record: TerminalRecord = { info, pty: null, chunks: [], seq: 0 };
    this.terminals.set(info.id, record);

    let pty: IPty;
    try {
      pty = spawnPty(shell, [], {
        name: "xterm-256color",
        cols: info.cols,
        rows: info.rows,
        cwd: cwdAbs,
        env: process.env as Record<string, string>,
      });
    } catch (err) {
      this.exit(record, null, `Failed to spawn ${shell}: ${(err as Error).message}`);
      return { ...info };
    }
    record.pty = pty;

    pty.onData((text) => this.push(record, "stdout", text));
    pty.onExit(({ exitCode }) => {
      this.exit(record, exitCode ?? null, `\r\n[terminal exited with code ${exitCode ?? "?"}]\r\n`);
    });

    this.events.emit("changed", { terminal: { ...info } });
    return { ...info };
  }

  /** Write raw bytes (keystrokes/control chars) to the PTY — it echoes them itself. */
  input(terminalId: string, data: string): void {
    const record = this.get(terminalId);
    if (record.info.status !== "running" || !record.pty) {
      throw new Error(`Terminal ${terminalId} is not running`);
    }
    record.pty.write(data);
  }

  /** Resize the PTY. Last writer wins; the new size broadcasts via `changed`. */
  resize(terminalId: string, cols: number, rows: number): void {
    const record = this.get(terminalId);
    const nextCols = clampDim(cols, record.info.cols);
    const nextRows = clampDim(rows, record.info.rows);
    if (nextCols === record.info.cols && nextRows === record.info.rows) return;
    record.info.cols = nextCols;
    record.info.rows = nextRows;
    if (record.info.status === "running" && record.pty) {
      record.pty.resize(nextCols, nextRows);
    }
    this.events.emit("changed", { terminal: { ...record.info } });
  }

  /** Kill the process (if still running) and drop the terminal from the list. */
  kill(terminalId: string): void {
    const record = this.get(terminalId);
    this.killTree(record);
    this.terminals.delete(terminalId);
    record.info.status = "exited";
    record.info.exitCode ??= null;
    this.events.emit("changed", { terminal: { ...record.info } });
  }

  buffer(terminalId: string): TerminalChunk[] {
    return [...this.get(terminalId).chunks];
  }

  /** Server shutdown: kill every child without broadcasting. */
  disposeAll(): void {
    for (const record of this.terminals.values()) {
      this.killTree(record);
    }
    this.terminals.clear();
  }

  private killTree(record: TerminalRecord): void {
    const pty = record.pty;
    if (record.info.status !== "running" || !pty) return;
    // Same tree-kill as agent runs: shells spawn children of their own.
    if (process.platform === "win32") {
      spawnProcess("taskkill", ["/pid", String(pty.pid), "/T", "/F"], { shell: false });
    }
    try {
      pty.kill();
    } catch {
      /* already dead */
    }
  }

  private get(terminalId: string): TerminalRecord {
    const record = this.terminals.get(terminalId);
    if (!record) throw new Error(`Unknown terminal: ${terminalId}`);
    return record;
  }

  private push(record: TerminalRecord, stream: TerminalStream, text: string): void {
    const chunk: TerminalChunk = {
      terminalId: record.info.id,
      seq: record.seq++,
      stream,
      text,
    };
    record.chunks.push(chunk);
    if (record.chunks.length > MAX_BUFFER_CHUNKS) {
      record.chunks.splice(0, record.chunks.length - MAX_BUFFER_CHUNKS);
    }
    this.events.emit("data", { chunk });
  }

  private exit(record: TerminalRecord, code: number | null, message: string): void {
    if (record.info.status === "exited") return;
    record.info.status = "exited";
    record.info.exitCode = code;
    this.push(record, "system", message);
    this.events.emit("changed", { terminal: { ...record.info } });
  }
}

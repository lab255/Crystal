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
 * Wrap text for injection into a TUI's input as one paste: bracketed-paste
 * markers keep embedded newlines from submitting line-by-line, the trailing
 * \r submits. This is exactly what a terminal emulator sends when a user
 * pastes and hits Enter.
 */
export function pasteInput(text: string): string {
  return `\x1b[200~${text}\x1b[201~\r`;
}

/** A program (argv, not a shell line) for a terminal to run instead of a bare shell. */
export interface TerminalCommand {
  file: string;
  args: string[];
  env?: Record<string, string | undefined>;
}

export interface TerminalCreateOptions {
  cwd?: string;
  cols?: number;
  rows?: number;
  /** Run this program on the PTY instead of the default shell. */
  command?: TerminalCommand;
  /** Tab label override (command terminals — interactive agent sessions). */
  title?: string | null;
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

  create(opts: TerminalCreateOptions = {}): TerminalInfo {
    const cwdAbs = resolveInRoot(this.root, opts.cwd ?? ".");
    // A .cmd/.bat command can't be CreateProcess'd directly — route it through
    // cmd.exe. NOT as argv: node-pty would quote the spaced shim path AND the
    // spaced args (--allowedTools always has spaces), and with >2 quotes after
    // /c, cmd strips the first and last quote of the whole tail — executing
    // `C:\Users\Eliot` instead of the shim. Hand node-pty a verbatim command
    // line (string args pass through untouched) in the same `/d /s /c "..."`
    // outer-quote form child_process uses for shell spawns. Args here are
    // internal (paths, flags, ids) — never free-form user text (prompts go
    // over the PTY as input, same as CLAUDE.md's stdin rule) — so embedded
    // quotes are stripped rather than escaped.
    let file = opts.command?.file ?? defaultShell();
    let args: string[] | string = opts.command ? [...opts.command.args] : [];
    if (opts.command && process.platform === "win32" && /\.(cmd|bat)$/i.test(file)) {
      const q = (a: string) => {
        const clean = a.replace(/"/g, "");
        return /\s/.test(clean) ? `"${clean}"` : clean;
      };
      const tail = [file, ...opts.command.args].map(q).join(" ");
      args = `/d /s /c "${tail}"`;
      file = process.env.ComSpec ?? "cmd.exe";
    }
    const info: TerminalInfo = {
      id: uid("term"),
      cwd: toRelPath(this.root, cwdAbs) || ".",
      shell: file,
      title: opts.title ?? null,
      status: "running",
      exitCode: null,
      createdAt: nowIso(),
      cols: clampDim(opts.cols, DEFAULT_COLS),
      rows: clampDim(opts.rows, DEFAULT_ROWS),
    };
    const record: TerminalRecord = { info, pty: null, chunks: [], seq: 0 };
    this.terminals.set(info.id, record);

    let pty: IPty;
    try {
      pty = spawnPty(file, args, {
        name: "xterm-256color",
        cols: info.cols,
        rows: info.rows,
        cwd: cwdAbs,
        // A command's env is COMPLETE, not a patch — merging over process.env
        // would resurrect keys the caller deliberately removed (the
        // child-session marker that disables transcript saving).
        env: (opts.command?.env ?? process.env) as Record<string, string>,
      });
    } catch (err) {
      this.exit(record, null, `Failed to spawn ${file}: ${(err as Error).message}`);
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

  /**
   * Type `text` into the terminal as one paste after `delayMs` — the seam for
   * feeding an interactive agent session its opening prompt. A TUI isn't
   * reading raw input the instant it spawns; the delay gives it time to mount
   * and enable bracketed paste. Best-effort: a terminal that died (or was
   * killed) before the timer fires just drops the write.
   */
  writeWhenReady(terminalId: string, text: string, delayMs: number): void {
    const timer = setTimeout(() => {
      try {
        this.input(terminalId, pasteInput(text));
      } catch {
        // Terminal exited before it could take the prompt — visible in its
        // scrollback, nothing further to do.
      }
    }, delayMs);
    timer.unref?.();
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
      const killer = spawnProcess("taskkill", ["/pid", String(pty.pid), "/T", "/F"], {
        shell: false,
      });
      // Attached synchronously, or a missing/blocked taskkill emits an
      // unhandled `error` next tick and takes the whole server down —
      // pty.kill() below is the fallback either way.
      killer.on("error", () => {});
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

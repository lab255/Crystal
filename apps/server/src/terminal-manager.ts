import { spawn as spawnProcess } from "node:child_process";
import path from "node:path";
import { spawn as spawnPty, type IPty } from "@lydell/node-pty";
import {
  Emitter,
  nowIso,
  uid,
  type TerminalChunk,
  type TerminalInfo,
  type TerminalStream,
} from "@crystal/core";
import { agentEnv, stripApiKey } from "./agent-manager.js";
import { envWithToolchain } from "./claude-bin.js";
import { resolveInRoot, toRelPath } from "./paths.js";

/** Replay buffer cap per terminal — enough scrollback without unbounded memory. */
const MAX_BUFFER_CHUNKS = 2000;

/** Grace a POSIX process group gets after SIGTERM before SIGKILL escalation. */
const KILL_GRACE_MS = 500;
/** Liveness poll interval while waiting out the SIGTERM grace. */
const KILL_POLL_MS = 50;

/** Signal-0 liveness probe; EPERM still means "alive, just not ours". */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

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

/**
 * A dead terminal's restorable state: its listing record plus scrollback.
 * What `disposeAll()` returns after the kills complete and what `seed()`
 * adopts into a fresh manager (buffer-preserving workspace reopen).
 */
export interface TerminalSeed {
  info: TerminalInfo;
  chunks: TerminalChunk[];
}

export interface TerminalCreateOptions {
  cwd?: string;
  cols?: number;
  rows?: number;
  /**
   * Internal-only capability for server-resolved absolute paths (notably an
   * adopted agent worktree outside the workspace root). Never expose or
   * forward this through the terminal.create bridge method.
   */
  trustedCwd?: boolean;
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
    // Only an explicit internal capability may re-enter an agent chain's
    // server-resolved worktree outside the workspace root. A command alone
    // proves nothing about who supplied its cwd.
    const cwdAbs =
      opts.trustedCwd === true && opts.cwd && path.isAbsolute(opts.cwd)
        ? path.resolve(opts.cwd)
        : resolveInRoot(this.root, opts.cwd ?? ".");
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
        // child-session marker that disables transcript saving). Plain shells
        // (no command) get the project toolchain on PATH — a workspace
        // terminal where `pnpm`/`node` ENOENT is broken, whatever bare env a
        // GUI-launched server inherited — with the same two agent-spawn
        // guards: no inherited child-session marker (a manual `claude` run
        // here must still save transcripts / be resumable) and no leaked
        // ANTHROPIC_API_KEY silently switching billing (CRYSTAL_ALLOW_API_KEY=1
        // opts back in, same as agent spawns).
        env: (opts.command?.env ??
          envWithToolchain(agentEnv(stripApiKey(process.env)), [cwdAbs, this.root])) as Record<
          string,
          string
        >,
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

  /**
   * Kill the process (if still running) and drop the terminal from the list.
   * The record stays in the map until the tree is confirmed dead, then the
   * delete + `changed` broadcast land as before. Killing a seeded (exited,
   * no-pty) record is just delete + emit.
   */
  async kill(terminalId: string): Promise<void> {
    const record = this.get(terminalId);
    await this.killTree(record);
    this.terminals.delete(terminalId);
    record.info.status = "exited";
    record.info.exitCode ??= null;
    this.events.emit("changed", { terminal: { ...record.info } });
  }

  buffer(terminalId: string): TerminalChunk[] {
    return [...this.get(terminalId).chunks];
  }

  /**
   * Workspace close / server shutdown: kill every child without
   * broadcasting. Resolves once every tree is confirmed dead, returning the
   * dead records so a reopen of the same root can `seed()` them back
   * (scrollback intact, zero process leakage).
   */
  async disposeAll(): Promise<TerminalSeed[]> {
    const records = [...this.terminals.values()];
    this.terminals.clear();
    await Promise.all(records.map((record) => this.killTree(record)));
    return records.map((record) => ({
      info: { ...record.info, status: "exited" as const },
      chunks: [...record.chunks],
    }));
  }

  /**
   * Adopt terminal records from a previous runtime of this root
   * (buffer-preserving reopen). Seeded tabs are inert `exited` shells — no
   * pty behind them — matching the existing contract that exited terminals
   * stay listed (scrollback intact) until killed. Ids are `uid("term")`, so
   * a later create() can never collide with a seeded id. No broadcast:
   * seeding happens before the runtime's listeners attach, and clients pick
   * the tabs up through their `terminal.list` refresh.
   */
  seed(seeds: TerminalSeed[]): void {
    for (const s of seeds) {
      if (this.terminals.has(s.info.id)) continue;
      const last = s.chunks[s.chunks.length - 1];
      this.terminals.set(s.info.id, {
        info: { ...s.info, status: "exited" },
        pty: null,
        chunks: [...s.chunks],
        seq: (last?.seq ?? -1) + 1,
      });
    }
  }

  /**
   * Deterministic tree-kill: resolves once the process tree is actually gone
   * (taskkill exit on Windows; group SIGTERM → grace → SIGKILL on POSIX), so
   * callers like workspace close and dev-server stop know the ports and
   * files are released. Never throws — pty.kill() is the last-resort
   * fallback either way, and a no-op record (exited/seeded) resolves
   * immediately.
   */
  private async killTree(record: TerminalRecord): Promise<void> {
    const pty = record.pty;
    if (record.info.status !== "running" || !pty) return;
    const pid = pty.pid;
    if (process.platform === "win32") {
      // Same tree-kill as agent runs: shells spawn children of their own.
      await new Promise<void>((resolve) => {
        const killer = spawnProcess("taskkill", ["/pid", String(pid), "/T", "/F"], {
          shell: false,
        });
        // Attached synchronously, or a missing/blocked taskkill emits an
        // unhandled `error` next tick and takes the whole server down —
        // pty.kill() below is the fallback either way.
        killer.on("error", () => resolve());
        killer.on("exit", () => resolve());
      });
    } else {
      // node-pty starts the shell as a session leader, so its pid doubles as
      // the process-group id: signal the whole group, then escalate if it
      // ignored SIGTERM.
      try {
        process.kill(-pid, "SIGTERM");
        const deadline = Date.now() + KILL_GRACE_MS;
        while (isAlive(pid) && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, KILL_POLL_MS));
        }
        if (isAlive(pid)) process.kill(-pid, "SIGKILL");
      } catch {
        // Group already gone (or the shell never became a leader) —
        // pty.kill() below covers the remainder.
      }
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

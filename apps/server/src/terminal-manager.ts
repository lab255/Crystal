import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
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

interface TerminalRecord {
  info: TerminalInfo;
  child: ChildProcessWithoutNullStreams | null;
  chunks: TerminalChunk[];
  seq: number;
}

function defaultShell(): string {
  return process.platform === "win32"
    ? (process.env.ComSpec ?? "cmd.exe")
    : (process.env.SHELL ?? "/bin/bash");
}

/**
 * Line-mode terminals for one workspace: a persistent shell per terminal with
 * piped stdio (no PTY — interactive TUIs won't render, but builds, tests, git
 * and dev servers work fine). Output is buffered for replay and emitted as
 * sequenced chunks; exited terminals stay listed (scrollback intact) until
 * killed.
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

  create(cwd = "."): TerminalInfo {
    const cwdAbs = resolveInRoot(this.root, cwd);
    const shell = defaultShell();
    const info: TerminalInfo = {
      id: uid("term"),
      cwd: toRelPath(this.root, cwdAbs) || ".",
      shell,
      status: "running",
      exitCode: null,
      createdAt: nowIso(),
    };
    const record: TerminalRecord = { info, child: null, chunks: [], seq: 0 };
    this.terminals.set(info.id, record);

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(shell, [], {
        cwd: cwdAbs,
        env: { ...process.env, FORCE_COLOR: "0", TERM: "dumb" },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (err) {
      this.exit(record, null, `Failed to spawn ${shell}: ${(err as Error).message}`);
      return { ...info };
    }
    record.child = child;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (text: string) => this.push(record, "stdout", text));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (text: string) => this.push(record, "stderr", text));
    child.on("error", (err) => {
      this.exit(record, null, `Failed to spawn ${shell}: ${err.message}`);
    });
    child.on("close", (code) => {
      this.exit(record, code ?? null, `\n[terminal exited with code ${code ?? "?"}]\n`);
    });

    this.events.emit("changed", { terminal: { ...info } });
    return { ...info };
  }

  /** Write to the terminal's stdin, echoing it into the transcript. */
  input(terminalId: string, data: string): void {
    const record = this.get(terminalId);
    if (record.info.status !== "running" || !record.child) {
      throw new Error(`Terminal ${terminalId} is not running`);
    }
    this.push(record, "input", data);
    record.child.stdin.write(data);
  }

  /** Kill the process (if still running) and drop the terminal from the list. */
  kill(terminalId: string): void {
    const record = this.get(terminalId);
    const child = record.child;
    if (record.info.status === "running" && child?.pid) {
      // Same tree-kill as agent runs: shells spawn children of their own.
      if (process.platform === "win32") {
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { shell: false });
      } else {
        child.kill("SIGTERM");
      }
    }
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
      const child = record.child;
      if (record.info.status === "running" && child?.pid) {
        if (process.platform === "win32") {
          spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { shell: false });
        } else {
          child.kill("SIGTERM");
        }
      }
    }
    this.terminals.clear();
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

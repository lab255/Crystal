import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  Emitter,
  devServerCandidatesForPackage,
  matchDevUrl,
  type DevServerCandidate,
  type DevServerInfo,
} from "@crystal/core";
import { isIgnoredDir, resolveInRoot } from "./paths.js";
import type { TerminalManager } from "./terminal-manager.js";

/** package.json this deep still counts (matches the quality/code-map walkers). */
const PACKAGE_MAX_DEPTH = 3;

interface RunningServer {
  terminalId: string;
  /** URL observed in the terminal output, null until the server announces one. */
  url: string | null;
}

/**
 * Dev servers for one workspace: monorepo-aware candidate detection (every
 * package's scripts through the pure rules in core/dev-server.ts) plus a
 * running-state ledger over the workspace's PTY terminals. A started server
 * IS a terminal — it shows up in the terminal panel with full scrollback, and
 * killing either side is the same operation. The service listens to terminal
 * output to learn the server's real URL (vite's auto-increment and .env ports
 * make static guesses wrong) and to terminal exits to drop dead entries.
 */
export class DevServerService {
  readonly events = new Emitter<{ changed: Record<string, never> }>();

  private readonly running = new Map<string, RunningServer>();
  private readonly disposers: (() => void)[];

  constructor(
    private readonly root: string,
    private readonly terminals: TerminalManager,
  ) {
    this.disposers = [
      this.terminals.events.on("data", ({ chunk }) => {
        for (const [id, state] of this.running) {
          if (state.terminalId !== chunk.terminalId || state.url) continue;
          const url = matchDevUrl(chunk.text);
          if (url) {
            this.running.set(id, { ...state, url });
            this.events.emit("changed", {});
          }
        }
      }),
      this.terminals.events.on("changed", ({ terminal }) => {
        if (terminal.status !== "exited") return;
        for (const [id, state] of this.running) {
          if (state.terminalId === terminal.id) {
            this.running.delete(id);
            this.events.emit("changed", {});
          }
        }
      }),
    ];
  }

  /**
   * Workspace close: stop listening AND stop every running dev server — a
   * closed workspace must not keep its ports bound. Kills go through the
   * terminal manager (a started server IS a terminal); the runtime's
   * `terminals.disposeAll()` runs right after and double-killing the same
   * tree is harmless (taskkill/SIGTERM on a dead pid fails quietly and
   * killTree never throws).
   */
  async dispose(): Promise<void> {
    for (const d of this.disposers) d();
    const running = [...this.running.values()];
    this.running.clear();
    await Promise.all(
      running.map(({ terminalId }) => this.terminals.kill(terminalId).catch(() => {})),
    );
  }

  /** Candidates merged with live state (running entries pruned via terminal exits). */
  async list(): Promise<{ servers: DevServerInfo[] }> {
    const candidates = await this.detect();
    return { servers: candidates.map((c) => this.withState(c)) };
  }

  async start(id: string): Promise<{ server: DevServerInfo }> {
    const candidate = await this.find(id);
    if (this.running.has(id)) {
      throw new Error(`${candidate.script} is already running — restart it instead`);
    }
    const pm = await this.packageManager();
    const win = process.platform === "win32";
    const terminal = this.terminals.create({
      cwd: candidate.dir,
      // Through the shell-resolved PM shim; TerminalManager routes .cmd shims
      // through cmd.exe itself, so plain names are enough here.
      command: {
        file: pm + (win ? ".cmd" : ""),
        args: ["run", candidate.script],
      },
      title: `dev: ${candidate.pkgName ?? candidate.dir}${candidate.script === "dev" ? "" : ` ${candidate.script}`}`,
    });
    if (terminal.status === "exited") {
      throw new Error(`Failed to start ${pm} run ${candidate.script} in ${candidate.dir}`);
    }
    this.running.set(id, { terminalId: terminal.id, url: null });
    this.events.emit("changed", {});
    return { server: this.withState(candidate) };
  }

  async stop(id: string): Promise<{ ok: true }> {
    const state = this.running.get(id);
    if (state) {
      this.running.delete(id);
      await this.terminals.kill(state.terminalId).catch(() => {
        // terminal already gone — the ledger entry was stale
      });
      this.events.emit("changed", {});
    }
    return { ok: true };
  }

  async restart(id: string): Promise<{ server: DevServerInfo }> {
    await this.stop(id);
    // The tree-kill is awaited, but the OS can still take a beat to release
    // the old process's port before the successor binds it.
    await new Promise((resolve) => setTimeout(resolve, 750));
    return this.start(id);
  }

  private withState(candidate: DevServerCandidate): DevServerInfo {
    const state = this.running.get(candidate.id);
    return {
      ...candidate,
      status: state ? "running" : "stopped",
      terminalId: state?.terminalId ?? null,
      url: state ? (state.url ?? candidate.urlGuess) : null,
    };
  }

  private async find(id: string): Promise<DevServerCandidate> {
    const candidate = (await this.detect()).find((c) => c.id === id);
    if (!candidate) throw new Error(`Unknown dev server: ${id}`);
    return candidate;
  }

  private async detect(): Promise<DevServerCandidate[]> {
    const out: DevServerCandidate[] = [];
    const walk = async (rel: string, depth: number): Promise<void> => {
      const abs = rel === "." ? this.root : resolveInRoot(this.root, rel);
      let entries: fsSync.Dirent[];
      try {
        entries = await fs.readdir(abs, { withFileTypes: true });
      } catch {
        return;
      }
      if (entries.some((e) => e.isFile() && e.name === "package.json")) {
        try {
          const pkg = JSON.parse(await fs.readFile(path.join(abs, "package.json"), "utf8")) as {
            name?: unknown;
            scripts?: Record<string, string>;
          };
          out.push(
            ...devServerCandidatesForPackage(
              rel,
              typeof pkg.name === "string" ? pkg.name : null,
              pkg.scripts,
            ),
          );
        } catch {
          // unparseable package.json — not a candidate source
        }
      }
      if (depth >= PACKAGE_MAX_DEPTH) return;
      for (const entry of entries) {
        if (entry.isDirectory() && !isIgnoredDir(entry.name) && !entry.name.startsWith(".")) {
          await walk(rel === "." ? entry.name : `${rel}/${entry.name}`, depth + 1);
        }
      }
    };
    await walk(".", 0);
    // Roots last within equal kinds reads better in the launcher, but keep it
    // simple and deterministic: kind rank (already applied per package), then
    // app dirs alphabetically with the root's own scripts at the end.
    return out.sort(
      (a, z) =>
        rankOf(a) - rankOf(z) ||
        (a.dir === "." ? 1 : 0) - (z.dir === "." ? 1 : 0) ||
        a.id.localeCompare(z.id),
    );
  }

  private async packageManager(): Promise<string> {
    if (await this.fileExists(path.join(this.root, "pnpm-lock.yaml"))) return "pnpm";
    if (await this.fileExists(path.join(this.root, "yarn.lock"))) return "yarn";
    return "npm";
  }

  private fileExists(abs: string): Promise<boolean> {
    return fs.stat(abs).then(
      (st) => st.isFile(),
      () => false,
    );
  }
}

const KIND_RANK = { app: 0, storybook: 1, docs: 2, api: 3, task: 4 } as const;
function rankOf(c: DevServerCandidate): number {
  return KIND_RANK[c.kind];
}

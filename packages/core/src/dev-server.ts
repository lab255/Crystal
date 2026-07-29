/**
 * Dev servers — pure detection rules. The server walks every workspace
 * package.json (monorepo-aware, unlike the old root-only surfaces guess) and
 * folds each package's scripts through `devServerCandidatesForPackage`;
 * running one is a PTY terminal spawn (`devservers.start`), and the *actual*
 * URL is sniffed from the process output (`matchDevUrl`) rather than trusted
 * from a static port guess — .env ports, vite's auto-increment and
 * `server.port` configs all lie to string parsing.
 */

/** What a candidate serves — drives icon/grouping in the launcher. */
export type DevServerKind = "app" | "storybook" | "docs" | "api" | "task";

export interface DevServerCandidate {
  /** Stable id: `<dir>::<script>` — survives re-detection. */
  id: string;
  /** Workspace-relative package dir ("." = root). */
  dir: string;
  /** package.json name, null when unnamed. */
  pkgName: string | null;
  /** Script key ("dev", "storybook", …). */
  script: string;
  /** Script command text (informational). */
  command: string;
  kind: DevServerKind;
  /** Static port guess as a URL, null when the command names no known port. */
  urlGuess: string | null;
}

/** A candidate merged with its live state — what `devservers.list` returns. */
export interface DevServerInfo extends DevServerCandidate {
  status: "stopped" | "running";
  /** The hosting PTY terminal while running (open it in the terminal panel). */
  terminalId: string | null;
  /** URL observed in the process output; falls back to `urlGuess` while running. */
  url: string | null;
}

interface ToolRule {
  re: RegExp;
  port: number | null;
  kind: DevServerKind;
}

// Order matters: earlier rules win (storybook before vite — a storybook
// script mentions vite's builder; vitest is excluded by the lookahead).
const TOOL_RULES: ToolRule[] = [
  { re: /\bstorybook\s+dev\b|\bstart-storybook\b/, port: 6006, kind: "storybook" },
  { re: /\bvitepress\s+(?:dev|serve)\b/, port: 5173, kind: "docs" },
  { re: /\bdocusaurus\s+start\b/, port: 3000, kind: "docs" },
  { re: /\bnext\s+dev\b/, port: 3000, kind: "app" },
  { re: /\b(?:nuxt|nuxi)\s+dev\b/, port: 3000, kind: "app" },
  { re: /\bastro\s+dev\b/, port: 4321, kind: "app" },
  { re: /\bremix\s+(?:dev|vite:dev)\b/, port: 3000, kind: "app" },
  { re: /\breact-scripts\s+start\b/, port: 3000, kind: "app" },
  { re: /\bwebpack\s+serve\b|\bwebpack-dev-server\b/, port: 8080, kind: "app" },
  { re: /\bng\s+serve\b/, port: 4200, kind: "app" },
  { re: /\brsbuild\s+dev\b/, port: 3000, kind: "app" },
  { re: /\bgatsby\s+develop\b/, port: 8000, kind: "app" },
  { re: /\bexpo\s+start\b/, port: 8081, kind: "app" },
  { re: /\bvite\b(?!st)/, port: 5173, kind: "app" },
  { re: /\bparcel\b(?!\s+build)/, port: 1234, kind: "app" },
  { re: /\bwrangler\s+dev\b/, port: 8787, kind: "api" },
  { re: /\bfastify\s+dev\b/, port: 3000, kind: "api" },
  { re: /\bnodemon\b|\bnode\s+--watch\b|\btsx\s+watch\b/, port: null, kind: "api" },
];

/** Commands that are never servers even under a dev-ish script key. */
const NON_SERVER_RE =
  /\b(?:vitest|jest|playwright|cypress|eslint|prettier|tsc|tsup|rollup|tauri)\b|\b(?:vite|next|nuxt|astro|webpack|rsbuild|parcel|storybook|gatsby)\s+build\b/;

/** Script keys that suggest a long-running dev process regardless of tool. */
const DEV_KEY_RE = /^(?:dev|serve|start|preview|storybook|watch)(?:[:._-].*)?$/i;

const PORT_ARG_RE = /(?:^|\s)(?:-p|--port)(?:[ =])(\d{2,5})\b/;
const PORT_ENV_RE = /\bPORT=(\d{2,5})\b/;

function guessPort(command: string, fallback: number | null): number | null {
  const arg = PORT_ARG_RE.exec(command) ?? PORT_ENV_RE.exec(command);
  if (arg?.[1]) return Number(arg[1]);
  return fallback;
}

/**
 * The dev-server candidates a package's scripts declare. A script qualifies
 * when its command matches a known dev tool (any key), or its key looks like
 * a dev entry point ("dev", "serve", "dev:web", …) and the command isn't a
 * known non-server (test runner, linter, bundler build). Orchestration
 * scripts (`pnpm --parallel … dev`) stay in — running the whole dev stack
 * from one button is the point — they just carry no port guess.
 */
export function devServerCandidatesForPackage(
  dir: string,
  pkgName: string | null,
  scripts: Record<string, string> | undefined,
): DevServerCandidate[] {
  const out: DevServerCandidate[] = [];
  for (const [key, raw] of Object.entries(scripts ?? {})) {
    if (typeof raw !== "string" || !raw.trim()) continue;
    if (/^(?:pre|post)/.test(key)) continue; // lifecycle hooks run implicitly
    const command = raw.trim();
    const tool = TOOL_RULES.find((t) => t.re.test(command));
    const devKey = DEV_KEY_RE.test(key);
    if (!tool && !devKey) continue;
    if (NON_SERVER_RE.test(command)) continue;
    const port = guessPort(command, tool?.port ?? null);
    out.push({
      id: `${dir}::${key}`,
      dir,
      pkgName,
      script: key,
      command,
      kind: tool?.kind ?? "task",
      urlGuess: port ? `http://localhost:${port}` : null,
    });
  }
  // Stable, launcher-friendly order: apps first, then the rest by key.
  const rank: Record<DevServerKind, number> = { app: 0, storybook: 1, docs: 2, api: 3, task: 4 };
  return out.sort((a, z) => rank[a.kind] - rank[z.kind] || a.script.localeCompare(z.script));
}

const ANSI_RE = /\u001b\[[0-9;]*[A-Za-z]/g;
const DEV_URL_RE =
  /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::\d{2,5})?(?:\/[^\s"'`)\]]*)?/i;

/**
 * First local URL in a chunk of process output (ANSI stripped), normalized to
 * a clickable localhost origin — how a running server's real address is
 * learned. Returns null when the chunk names none.
 */
export function matchDevUrl(text: string): string | null {
  const m = DEV_URL_RE.exec(text.replace(ANSI_RE, ""));
  if (!m) return null;
  return m[0]
    .replace("0.0.0.0", "localhost")
    .replace("[::1]", "localhost")
    .replace("[::]", "localhost")
    .replace(/[/.,;]+$/, "");
}

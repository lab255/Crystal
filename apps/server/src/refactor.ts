import fsSync from "node:fs";
import path from "node:path";
import ts from "typescript";
import type {
  MoveFileIntent,
  MoveIntent,
  RefactorApplyResult,
  RefactorChange,
  RefactorIntent,
  RefactorPlan,
} from "@crystal/core";
import type { CodeMapAnalyzer, ParsedSymbol } from "./code-map.js";
import { deleteAt, writeFileAt } from "./fs-api.js";
import { resolveInRoot, toRelPath } from "./paths.js";

/**
 * Deterministic symbolic refactors. Symbol moves try the TypeScript
 * LanguageService "Move to file" refactor first (full reference rewriting);
 * when the service declines, a manual textual move runs instead — the
 * declaration relocates and a re-export/import shim keeps the source file's
 * contract intact, so importers never break. Whole-file moves ride the
 * LanguageService's file-rename edits (importers rewritten project-wide),
 * with a code-map-driven specifier rewrite as the fallback. Hoist intents
 * are not handled here; they execute through an agent run.
 *
 * The LanguageService is expensive on big workspaces, so it is (a) created
 * lazily, (b) fed only a focused root-file set (source module ∪ target
 * module ∪ importers), and (c) disposed after five idle minutes.
 */

const IDLE_DISPOSE_MS = 5 * 60 * 1000;
const PREVIEW_CONTEXT_LINES = 5;
const PREVIEW_MAX_LINES = 40;

interface PlannedWrite {
  /** Workspace-relative path. */
  file: string;
  content: string;
  created: boolean;
}

interface MovePlan {
  engine: "language-service" | "manual";
  writes: PlannedWrite[];
  /** Workspace-relative files removed by the plan (whole-file moves). */
  deletes?: string[];
  warnings: string[];
}

/** New-content excerpt around the first line that differs from the old text. */
export function firstDiffPreview(oldText: string, newText: string): string {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  let first = 0;
  while (first < newLines.length && oldLines[first] === newLines[first]) first++;
  const start = Math.max(0, first - PREVIEW_CONTEXT_LINES);
  return newLines.slice(start, start + PREVIEW_MAX_LINES).join("\n");
}

/** Import specifier for `toFile` as written from `fromFile` (posix, .js style). */
export function specifierBetween(fromFile: string, toFile: string): string {
  const rel = path.posix
    .relative(path.posix.dirname(fromFile), toFile)
    .replace(/\.tsx?$/, ".js");
  return rel.startsWith(".") ? rel : `./${rel}`;
}

/**
 * Manual textual move: relocate the declaration and keep the old file's
 * public surface via a shim. Pure — exported for tests.
 */
export function planManualMove(opts: {
  intent: MoveIntent;
  sym: Pick<ParsedSymbol, "start" | "end" | "exported">;
  fromText: string;
  toFile: string;
  toText: string | null; // null = file does not exist yet
}): MovePlan {
  const { intent, sym, fromText, toFile, toText } = opts;
  const warnings: string[] = [];
  const decl = fromText.slice(sym.start, sym.end);
  let remaining = (fromText.slice(0, sym.start) + fromText.slice(sym.end)).replace(/\n{3,}/g, "\n\n");

  const spec = specifierBetween(intent.fromFile, toFile);
  const usedLocally = new RegExp(`\\b${intent.symbol}\\b`).test(remaining);
  if (sym.exported) {
    remaining = `${remaining.trimEnd()}\n\nexport { ${intent.symbol} } from "${spec}";\n`;
    warnings.push(`left a re-export shim in ${intent.fromFile} — importers keep working unchanged`);
    if (usedLocally) {
      remaining = `import { ${intent.symbol} } from "${spec}";\n${remaining}`;
      warnings.push(`${intent.fromFile} still uses ${intent.symbol} — added an import back`);
    }
  } else if (usedLocally) {
    remaining = `import { ${intent.symbol} } from "${spec}";\n${remaining}`;
    warnings.push(`${intent.fromFile} still uses ${intent.symbol} — added an import back`);
  }

  // The moved declaration must be importable from its new home.
  const movedDecl =
    sym.exported || usedLocally
      ? /^\s*export\b/.test(decl)
        ? decl
        : `export ${decl}`
      : decl;

  const writes: PlannedWrite[] = [
    { file: intent.fromFile, content: remaining, created: false },
    {
      file: toFile,
      content: toText == null ? `${movedDecl.trimEnd()}\n` : `${toText.trimEnd()}\n\n${movedDecl.trimEnd()}\n`,
      created: toText == null,
    },
  ];
  return { engine: "manual", writes, warnings };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Replace a quoted import specifier everywhere it appears in `text`. */
export function replaceSpecifier(text: string, oldSpec: string, newSpec: string): string {
  return text.replace(new RegExp(`(['"])${escapeRegex(oldSpec)}\\1`, "g"), `$1${newSpec}$1`);
}

/**
 * Manual whole-file move: the file's own relative imports are recomputed for
 * its new directory, and every importer's specifier is rewritten to the new
 * location (targets known from the code map) — no shim needed. Pure —
 * exported for tests.
 */
export function planManualFileMove(opts: {
  intent: MoveFileIntent;
  toFile: string;
  fromText: string;
  /** The moved file's imports (specifier + workspace-relative resolution). */
  ownImports: { specifier: string; resolved: string | null }[];
  /** Files importing the moved one, with the specifiers that resolve to it. */
  importers: { file: string; text: string; specifiers: string[] }[];
}): MovePlan {
  const { intent, toFile, importers } = opts;
  const warnings: string[] = [];

  let moved = opts.fromText;
  for (const imp of opts.ownImports) {
    if (!imp.resolved || !imp.specifier.startsWith(".")) continue;
    moved = replaceSpecifier(moved, imp.specifier, specifierBetween(toFile, imp.resolved));
  }

  const writes: PlannedWrite[] = [{ file: toFile, content: moved, created: true }];
  for (const importer of importers) {
    let text = importer.text;
    for (const spec of importer.specifiers) {
      text = replaceSpecifier(text, spec, specifierBetween(importer.file, toFile));
    }
    if (text !== importer.text) writes.push({ file: importer.file, content: text, created: false });
  }
  if (importers.length > 0) {
    warnings.push(
      `rewrote ${importers.length} importer${importers.length > 1 ? "s" : ""} by specifier match — review the diff`,
    );
  }
  return { engine: "manual", writes, deletes: [intent.fromFile], warnings };
}

export class RefactorEngine {
  private ls: ts.LanguageService | null = null;
  private lsFiles = new Set<string>(); // absolute paths
  private compilerOptions: ts.CompilerOptions | null = null;
  private idleTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly root: string,
    private readonly codemap: CodeMapAnalyzer,
  ) {}

  dispose(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.ls?.dispose();
    this.ls = null;
    this.lsFiles.clear();
  }

  async preview(intents: RefactorIntent[]): Promise<{ plans: RefactorPlan[] }> {
    const plans: RefactorPlan[] = [];
    for (const intent of intents) {
      if (intent.kind === "hoist") {
        plans.push({
          intentId: intent.id,
          engine: "agent",
          changes: intent.symbols.map((s) => ({
            file: s.file,
            summary: `duplicate "${s.symbol}" consolidates into ${intent.targetModule}`,
            preview: "",
          })),
          warnings: ["hoists execute via an agent run, not the refactor engine"],
        });
        continue;
      }
      try {
        const plan = await this.planFor(intent);
        plans.push({
          intentId: intent.id,
          engine: plan.engine,
          changes: [
            ...plan.writes.map((w) => this.changeFor(w)),
            ...(plan.deletes ?? []).map((file) => ({
              file,
              summary: "deleted — contents moved",
              preview: "",
            })),
          ],
          warnings: plan.warnings,
        });
      } catch (err) {
        plans.push({
          intentId: intent.id,
          engine: "manual",
          changes: [],
          warnings: [`cannot plan this move: ${(err as Error).message}`],
        });
      }
    }
    return { plans };
  }

  async apply(intents: RefactorIntent[]): Promise<RefactorApplyResult & { pathsTouched: string[] }> {
    const applied: RefactorApplyResult["applied"] = [];
    const failed: RefactorApplyResult["failed"] = [];
    const pathsTouched = new Set<string>();
    for (const intent of intents) {
      if (intent.kind === "hoist") {
        failed.push({ intentId: intent.id, error: "hoist intents execute via an agent run" });
        continue;
      }
      try {
        const plan = await this.planFor(intent);
        for (const write of plan.writes) {
          await writeFileAt(this.root, write.file, write.content);
          pathsTouched.add(write.file);
        }
        for (const del of plan.deletes ?? []) {
          await deleteAt(this.root, del);
          pathsTouched.add(del);
        }
        // Later intents must see this move's result.
        this.codemap.invalidate();
        applied.push({
          intentId: intent.id,
          filesTouched: [...plan.writes.map((w) => w.file), ...(plan.deletes ?? [])],
        });
      } catch (err) {
        failed.push({ intentId: intent.id, error: (err as Error).message });
      }
    }
    return { applied, failed, pathsTouched: [...pathsTouched] };
  }

  /* ---------------- planning ---------------- */

  private planFor(intent: MoveIntent | MoveFileIntent): Promise<MovePlan> {
    return intent.kind === "move" ? this.planMove(intent) : this.planFileMove(intent);
  }

  private async planMove(intent: MoveIntent): Promise<MovePlan> {
    const sym = await this.codemap.symbolMeta(intent.fromFile, intent.symbol);
    const toFile = intent.toFile ?? this.defaultTargetFile(intent);
    if (toFile === intent.fromFile) throw new Error("source and destination are the same file");

    const fromAbs = resolveInRoot(this.root, intent.fromFile);
    const fromText = fsSync.readFileSync(fromAbs, "utf8");
    const toAbs = resolveInRoot(this.root, toFile);
    const toText = fsSync.existsSync(toAbs) ? fsSync.readFileSync(toAbs, "utf8") : null;

    const viaLs = await this.tryLanguageServiceMove(intent, sym, toFile);
    if (viaLs) return viaLs;
    return planManualMove({ intent, sym, fromText, toFile, toText });
  }

  private defaultTargetFile(intent: MoveIntent): string {
    const kebab = intent.symbol
      .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-");
    const base = intent.toModule === "." ? "" : `${intent.toModule}/`;
    const srcDir = fsSync.existsSync(resolveInRoot(this.root, `${base}src`)) ? "src/" : "";
    return `${base}${srcDir}${kebab}.ts`;
  }

  /* ---------------- whole-file moves ---------------- */

  private async planFileMove(intent: MoveFileIntent): Promise<MovePlan> {
    const fromAbs = resolveInRoot(this.root, intent.fromFile);
    if (!fsSync.existsSync(fromAbs)) throw new Error(`${intent.fromFile} does not exist`);
    const toFile = intent.toFile ?? this.defaultFileTarget(intent);
    if (toFile === intent.fromFile) throw new Error("source and destination are the same file");
    const toAbs = resolveInRoot(this.root, toFile);
    if (fsSync.existsSync(toAbs)) throw new Error(`${toFile} already exists`);

    const viaLs = await this.tryLanguageServiceFileMove(intent, toFile);
    if (viaLs) return viaLs;

    const detail = await this.codemap.fileDetail(intent.fromFile);
    const importers = await Promise.all(
      (await this.codemap.importersOf(intent.fromFile)).map(async (file) => ({
        file,
        text: fsSync.readFileSync(resolveInRoot(this.root, file), "utf8"),
        specifiers: (await this.codemap.fileDetail(file)).imports
          .filter((imp) => imp.resolved === intent.fromFile)
          .map((imp) => imp.specifier),
      })),
    );
    return planManualFileMove({
      intent,
      toFile,
      fromText: fsSync.readFileSync(fromAbs, "utf8"),
      ownImports: detail.imports.map((imp) => ({ specifier: imp.specifier, resolved: imp.resolved })),
      importers,
    });
  }

  private defaultFileTarget(intent: MoveFileIntent): string {
    const name = intent.fromFile.split("/").pop()!;
    const base = intent.toModule === "." ? "" : `${intent.toModule}/`;
    const srcDir = fsSync.existsSync(resolveInRoot(this.root, `${base}src`)) ? "src/" : "";
    return `${base}${srcDir}${name}`;
  }

  /**
   * `getEditsForFileRename` rewrites import specifiers project-wide when a
   * file moves — edits land on the old paths; the physical move is ours.
   */
  private async tryLanguageServiceFileMove(
    intent: MoveFileIntent,
    toFile: string,
  ): Promise<MovePlan | null> {
    try {
      const roots = new Set<string>([intent.fromFile]);
      for (const f of await this.codemap.filesOfModule(await this.codemap.moduleOfFile(intent.fromFile)))
        roots.add(f);
      for (const f of await this.codemap.filesOfModule(intent.toModule).catch(() => [] as string[]))
        roots.add(f);
      for (const f of await this.codemap.importersOf(intent.fromFile)) roots.add(f);

      const ls = this.ensureLanguageService(roots);
      // TS path APIs want forward slashes — backslash inputs silently yield no edits.
      const fromAbs = resolveInRoot(this.root, intent.fromFile).replace(/\\/g, "/");
      const toAbs = resolveInRoot(this.root, toFile).replace(/\\/g, "/");
      const edits = ls.getEditsForFileRename(fromAbs, toAbs, ts.getDefaultFormatCodeSettings("\n"), {
        allowTextChangesInNewFiles: true,
        quotePreference: "double",
      });

      const writes: PlannedWrite[] = [];
      let movedContent: string | null = null;
      for (const change of edits) {
        const abs = path.resolve(change.fileName);
        let text = fsSync.existsSync(abs) ? fsSync.readFileSync(abs, "utf8") : "";
        const sorted = [...change.textChanges].sort((a, b) => b.span.start - a.span.start);
        for (const tc of sorted) {
          text = text.slice(0, tc.span.start) + tc.newText + text.slice(tc.span.start + tc.span.length);
        }
        if (abs === path.resolve(fromAbs)) {
          movedContent = text; // its own relative imports, rewritten for the new home
        } else {
          writes.push({ file: toRelPath(this.root, abs), content: text, created: false });
        }
      }
      writes.push({
        file: toFile,
        content: movedContent ?? fsSync.readFileSync(fromAbs, "utf8"),
        created: true,
      });
      return { engine: "language-service", writes, deletes: [intent.fromFile], warnings: [] };
    } catch {
      // Any LS hiccup falls back to the manual move — never fail the intent here.
      return null;
    }
  }

  private async tryLanguageServiceMove(
    intent: MoveIntent,
    sym: ParsedSymbol,
    toFile: string,
  ): Promise<MovePlan | null> {
    try {
      const roots = new Set<string>([intent.fromFile]);
      for (const f of await this.codemap.filesOfModule(await this.codemap.moduleOfFile(intent.fromFile)))
        roots.add(f);
      for (const f of await this.codemap.filesOfModule(intent.toModule).catch(() => [] as string[]))
        roots.add(f);
      for (const f of await this.codemap.importersOf(intent.fromFile)) roots.add(f);

      const ls = this.ensureLanguageService(roots);
      // TS path APIs want forward slashes — backslash inputs silently yield no edits.
      const fromAbs = resolveInRoot(this.root, intent.fromFile).replace(/\\/g, "/");
      const toAbs = resolveInRoot(this.root, toFile).replace(/\\/g, "/");
      const span: ts.TextRange = { pos: sym.start, end: sym.end };
      const prefs: ts.UserPreferences = {
        allowTextChangesInNewFiles: true,
        quotePreference: "double",
      };

      // NB: the 5th param filters by refactor *kind* (e.g. "refactor.move.file"),
      // not by display name — passing the name silently filters everything out.
      const applicable = ls.getApplicableRefactors(fromAbs, span, prefs, "invoked", "refactor.move.file", true);
      if (!applicable.some((r) => r.name === "Move to file")) return null;

      const edits = ls.getEditsForRefactor(
        fromAbs,
        ts.getDefaultFormatCodeSettings("\n"),
        span,
        "Move to file",
        "Move to file",
        prefs,
        { targetFile: toAbs },
      );
      if (!edits || edits.edits.length === 0) return null;

      const writes: PlannedWrite[] = [];
      for (const change of edits.edits) {
        const rel = toRelPath(this.root, change.fileName);
        const created = change.isNewFile === true || !fsSync.existsSync(change.fileName);
        let text = created ? "" : fsSync.readFileSync(change.fileName, "utf8");
        // Apply edits back-to-front so earlier spans stay valid.
        const sorted = [...change.textChanges].sort((a, b) => b.span.start - a.span.start);
        for (const tc of sorted) {
          text = text.slice(0, tc.span.start) + tc.newText + text.slice(tc.span.start + tc.span.length);
        }
        writes.push({ file: rel, content: text, created });
      }
      return { engine: "language-service", writes, warnings: [] };
    } catch {
      // Any LS hiccup falls back to the manual move — never fail the intent here.
      return null;
    }
  }

  private changeFor(write: PlannedWrite): RefactorChange {
    let summary: string;
    let preview: string;
    if (write.created) {
      summary = "new file";
      preview = write.content.split("\n").slice(0, PREVIEW_MAX_LINES).join("\n");
    } else {
      const abs = resolveInRoot(this.root, write.file);
      const oldText = fsSync.existsSync(abs) ? fsSync.readFileSync(abs, "utf8") : "";
      const delta = write.content.split("\n").length - oldText.split("\n").length;
      summary = `${delta >= 0 ? "+" : ""}${delta} lines`;
      preview = firstDiffPreview(oldText, write.content);
    }
    return { file: write.file, summary, preview };
  }

  /* ---------------- LanguageService plumbing ---------------- */

  private ensureLanguageService(rootFiles: Set<string>): ts.LanguageService {
    this.touch();
    let grew = false;
    for (const rel of rootFiles) {
      const abs = resolveInRoot(this.root, rel);
      if (fsSync.existsSync(abs) && !this.lsFiles.has(abs)) {
        this.lsFiles.add(abs);
        grew = true;
      }
    }
    if (this.ls && !grew) return this.ls;
    // Root set changed: rebuild (the DocumentRegistry keeps parse trees warm).
    this.ls?.dispose();
    this.compilerOptions ??= this.loadCompilerOptions();
    const host: ts.LanguageServiceHost = {
      getScriptFileNames: () => [...this.lsFiles],
      getScriptVersion: (fileName) => {
        try {
          return String(fsSync.statSync(fileName).mtimeMs);
        } catch {
          return "0";
        }
      },
      getScriptSnapshot: (fileName) => {
        try {
          return ts.ScriptSnapshot.fromString(fsSync.readFileSync(fileName, "utf8"));
        } catch {
          return undefined;
        }
      },
      getCurrentDirectory: () => this.root,
      getCompilationSettings: () => this.compilerOptions!,
      getDefaultLibFileName: (opts) => ts.getDefaultLibFilePath(opts),
      fileExists: ts.sys.fileExists,
      readFile: ts.sys.readFile,
      readDirectory: ts.sys.readDirectory,
      directoryExists: ts.sys.directoryExists,
      getDirectories: ts.sys.getDirectories,
    };
    this.ls = ts.createLanguageService(host, ts.createDocumentRegistry());
    return this.ls;
  }

  private loadCompilerOptions(): ts.CompilerOptions {
    const fallback: ts.CompilerOptions = {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      jsx: ts.JsxEmit.ReactJSX,
      allowJs: true,
      allowImportingTsExtensions: false,
    };
    try {
      const configPath = ts.findConfigFile(this.root, ts.sys.fileExists, "tsconfig.json");
      if (!configPath) return fallback;
      const read = ts.readConfigFile(configPath, ts.sys.readFile);
      if (read.error || !read.config) return fallback;
      const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, path.dirname(configPath));
      return { ...parsed.options, noEmit: true };
    } catch {
      return fallback;
    }
  }

  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.ls?.dispose();
      this.ls = null;
      this.lsFiles.clear();
    }, IDLE_DISPOSE_MS);
    this.idleTimer.unref?.();
  }
}

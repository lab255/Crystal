import { z } from "zod";
import type { CodeSymbol } from "./codemap.js";
import { uid } from "./ids.js";

/**
 * Symbolic refactor intents — proposals recorded on an architecture draft
 * (drag a function onto another file, hoist duplicates into a shared
 * package). They execute when the draft is applied and vanish with it:
 * mechanical moves run through the server's refactor engine, hoists through
 * an agent run. Intents are never merged three-way; they are re-validated
 * against the live code map instead (`validateRefactorIntents`).
 */

export const MoveIntentSchema = z.object({
  id: z.string(),
  kind: z.literal("move"),
  /** Top-level symbol name to move. */
  symbol: z.string(),
  /** Workspace-relative source file. */
  fromFile: z.string(),
  /** Module path receiving the symbol (always set). */
  toModule: z.string(),
  /** Exact destination file when the drop targeted a file node. */
  toFile: z.string().nullish(),
});
export type MoveIntent = z.infer<typeof MoveIntentSchema>;

export const HoistIntentSchema = z.object({
  id: z.string(),
  kind: z.literal("hoist"),
  /** The duplicate implementations to consolidate. */
  symbols: z
    .array(z.object({ file: z.string(), symbol: z.string() }))
    .min(2),
  /** Module path of the shared package (may not exist yet). */
  targetModule: z.string(),
  targetFile: z.string().nullish(),
  /** Optional canonical name for the hoisted function. */
  newName: z.string().nullish(),
});
export type HoistIntent = z.infer<typeof HoistIntentSchema>;

export const RefactorIntentSchema = z.discriminatedUnion("kind", [
  MoveIntentSchema,
  HoistIntentSchema,
]);
export type RefactorIntent = z.infer<typeof RefactorIntentSchema>;

export function createMoveIntent(
  symbol: string,
  fromFile: string,
  toModule: string,
  toFile?: string | null,
): MoveIntent {
  return { id: uid("refactor"), kind: "move", symbol, fromFile, toModule, toFile: toFile ?? null };
}

export function createHoistIntent(
  symbols: { file: string; symbol: string }[],
  targetModule: string,
  newName?: string | null,
): HoistIntent {
  return {
    id: uid("refactor"),
    kind: "hoist",
    symbols,
    targetModule,
    targetFile: null,
    newName: newName ?? null,
  };
}

export interface RefactorIntentProblem {
  intent: RefactorIntent;
  problem: string;
}

/**
 * Check intents against the live code map (upstream code may have renamed or
 * deleted symbols since the intent was recorded). `symbolIndex` returns a
 * file's top-level symbols, or null when the file is not in the map.
 */
export function validateRefactorIntents(
  intents: RefactorIntent[],
  symbolIndex: (file: string) => CodeSymbol[] | null,
): RefactorIntentProblem[] {
  const problems: RefactorIntentProblem[] = [];
  const check = (intent: RefactorIntent, file: string, symbol: string): void => {
    const symbols = symbolIndex(file);
    if (!symbols) problems.push({ intent, problem: `${file} is no longer in the code map` });
    else if (!symbols.some((s) => s.name === symbol)) {
      problems.push({ intent, problem: `"${symbol}" no longer exists in ${file}` });
    }
  };
  for (const intent of intents) {
    if (intent.kind === "move") check(intent, intent.fromFile, intent.symbol);
    else for (const ref of intent.symbols) check(intent, ref.file, ref.symbol);
  }
  return problems;
}

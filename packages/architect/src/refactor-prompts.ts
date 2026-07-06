import type { HoistIntent } from "@crystal/core";

/**
 * Prompt an agent run executes to hoist duplicate functions into a shared
 * package. The prompt is piped to the Claude CLI over stdin — never as a
 * shell argument.
 */
export function buildHoistPrompt(
  intent: HoistIntent,
  sources: { file: string; symbol: string; startLine?: number; endLine?: number; text?: string }[],
): string {
  const name = intent.newName ?? intent.symbols[0]!.symbol;
  const lines: string[] = [
    `Consolidate duplicated function implementations into the shared package "${intent.targetModule}".`,
    "",
    "## Duplicates to consolidate",
    "",
  ];
  for (const src of sources) {
    const range =
      src.startLine != null && src.endLine != null ? ` (lines ${src.startLine}-${src.endLine})` : "";
    lines.push(`### ${src.file} — \`${src.symbol}\`${range}`, "");
    if (src.text) lines.push("```ts", src.text, "```", "");
  }
  lines.push(
    "## Instructions",
    "",
    `1. Create or locate the target module at \`${intent.targetModule}\`${intent.targetFile ? ` (put the function in \`${intent.targetFile}\`)` : ""}. If the package does not exist yet, scaffold it consistently with the workspace's existing packages (package.json name, tsconfig, src/index.ts export barrel).`,
    `2. Reconcile the duplicate implementations into ONE canonical function named \`${name}\` — merge any signature differences sensibly and keep behavior identical for every current caller.`,
    "3. Export it from the target module's public entry point.",
    "4. Replace every duplicate listed above with an import of the canonical function; delete the dead copies.",
    "5. If an import now crosses package boundaries, add the dependency to the importing package's package.json.",
    "6. Run `pnpm typecheck` and fix anything the consolidation broke.",
  );
  return lines.join("\n");
}

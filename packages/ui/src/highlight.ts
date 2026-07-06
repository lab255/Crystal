/**
 * Minimal TypeScript/JavaScript syntax highlighter for read-only snippets.
 * A single O(n) scan — no regex backtracking — good enough for 30-line
 * previews; real editing stays in the Monaco editor mode.
 */

export type HighlightTokenType =
  | "keyword"
  | "string"
  | "comment"
  | "number"
  | "punct"
  | "plain";

export interface HighlightToken {
  text: string;
  type: HighlightTokenType;
}

const KEYWORDS = new Set([
  "abstract", "any", "as", "async", "await", "boolean", "break", "case", "catch",
  "class", "const", "continue", "debugger", "declare", "default", "delete", "do",
  "else", "enum", "export", "extends", "false", "finally", "for", "from",
  "function", "if", "implements", "import", "in", "infer", "instanceof",
  "interface", "keyof", "let", "namespace", "never", "new", "null", "number",
  "object", "of", "private", "protected", "public", "readonly", "return",
  "satisfies", "static", "string", "super", "switch", "symbol", "this", "throw",
  "true", "try", "type", "typeof", "undefined", "unknown", "var", "void",
  "while", "with", "yield",
]);

const isIdentStart = (c: string) => /[A-Za-z_$]/.test(c);
const isIdent = (c: string) => /[A-Za-z0-9_$]/.test(c);
const isDigit = (c: string) => c >= "0" && c <= "9";
const isQuote = (c: string) => c === '"' || c === "'" || c === "`";

export function highlightTs(code: string): HighlightToken[] {
  const tokens: HighlightToken[] = [];
  const push = (text: string, type: HighlightTokenType) => {
    if (!text) return;
    const last = tokens[tokens.length - 1];
    if (last && last.type === type) last.text += text;
    else tokens.push({ text, type });
  };

  let i = 0;
  const n = code.length;
  while (i < n) {
    const c = code[i]!;

    // Comments.
    if (c === "/" && code[i + 1] === "/") {
      let j = i;
      while (j < n && code[j] !== "\n") j++;
      push(code.slice(i, j), "comment");
      i = j;
      continue;
    }
    if (c === "/" && code[i + 1] === "*") {
      let j = i + 2;
      while (j < n && !(code[j] === "*" && code[j + 1] === "/")) j++;
      j = Math.min(n, j + 2);
      push(code.slice(i, j), "comment");
      i = j;
      continue;
    }

    // Strings (template `${}` interpolation kept inside the string token).
    if (isQuote(c)) {
      let j = i + 1;
      while (j < n) {
        if (code[j] === "\\") j += 2;
        else if (code[j] === c) {
          j++;
          break;
        } else if (code[j] === "\n" && c !== "`") break; // unterminated line string
        else j++;
      }
      push(code.slice(i, j), "string");
      i = j;
      continue;
    }

    // Numbers.
    if (isDigit(c) || (c === "." && isDigit(code[i + 1] ?? ""))) {
      let j = i;
      while (j < n && /[0-9a-fA-FxXoObBnE_.]/.test(code[j]!)) j++;
      push(code.slice(i, j), "number");
      i = j;
      continue;
    }

    // Identifiers / keywords.
    if (isIdentStart(c)) {
      let j = i;
      while (j < n && isIdent(code[j]!)) j++;
      const word = code.slice(i, j);
      push(word, KEYWORDS.has(word) ? "keyword" : "plain");
      i = j;
      continue;
    }

    // Whitespace rides along as plain text.
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      push(c, "plain");
      i++;
      continue;
    }

    push(c, "punct");
    i++;
  }
  return tokens;
}

/** Tokens split into lines for line-numbered rendering. */
export function highlightLines(code: string): HighlightToken[][] {
  const lines: HighlightToken[][] = [[]];
  for (const token of highlightTs(code)) {
    const parts = token.text.split("\n");
    parts.forEach((part, idx) => {
      if (idx > 0) lines.push([]);
      if (part) lines[lines.length - 1]!.push({ text: part, type: token.type });
    });
  }
  return lines;
}

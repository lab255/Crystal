import { useMemo } from "react";
import { cn } from "../cn.js";
import { highlightLines, type HighlightTokenType } from "../highlight.js";

const TOKEN_CLASS: Record<HighlightTokenType, string> = {
  keyword: "text-accent-violet",
  string: "text-accent-emerald",
  comment: "italic text-ink-faint",
  number: "text-accent-amber",
  punct: "text-ink-muted",
  plain: "text-ink",
};

export interface CodeSnippetProps {
  code: string;
  /** 1-based line number of the first line, for the gutter. */
  startLine?: number;
  /** Rendered under the code when the source was cut off. */
  truncated?: boolean;
  className?: string;
}

/** Read-only, line-numbered source snippet with lightweight TS highlighting. */
export function CodeSnippet({ code, startLine = 1, truncated, className }: CodeSnippetProps) {
  const lines = useMemo(() => highlightLines(code), [code]);
  const gutterWidth = String(startLine + lines.length - 1).length;

  return (
    <div className={cn("overflow-auto rounded-lg border border-edge bg-surface-0", className)}>
      <pre className="min-w-max p-2 font-mono text-[11px] leading-[1.55]">
        {lines.map((tokens, i) => (
          <div key={i} className="flex">
            <span className="mr-3 select-none text-right text-ink-faint" style={{ minWidth: `${gutterWidth}ch` }}>
              {startLine + i}
            </span>
            <span className="whitespace-pre">
              {tokens.map((t, j) => (
                <span key={j} className={TOKEN_CLASS[t.type]}>
                  {t.text}
                </span>
              ))}
            </span>
          </div>
        ))}
      </pre>
      {truncated ? (
        <div className="border-t border-edge px-2 py-1 text-[10px] text-ink-faint">
          Snippet truncated — open in editor for the full source.
        </div>
      ) : null}
    </div>
  );
}

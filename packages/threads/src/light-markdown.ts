export type InlineSpan =
  | { type: "text"; text: string }
  | { type: "bold" | "italic" | "code"; text: string }
  | { type: "link"; text: string; href: string };

export type Block =
  | { type: "paragraph"; spans: InlineSpan[] }
  | { type: "heading"; level: 1 | 2 | 3; spans: InlineSpan[] }
  | { type: "list"; ordered: boolean; start?: number; items: InlineSpan[][] }
  | { type: "code"; language: string; text: string };

const headingPattern = /^(#{1,3})[ \t]+(.+)$/;
const listPattern = /^\s*(?:(\d+)\.|([-*]))[ \t]+(.+)$/;
const fencePattern = /^```([^`]*)$/;
const closingFencePattern = /^```\s*$/;
const linkPattern = /\[([^\]\n]{1,400})\]\((https?:\/\/[^\s)]{1,2000})\)/y;

/** Parse the deliberately small Markdown subset used in assistant prose. */
export function renderLightMarkdown(text: string): Block[] {
  try {
    const lines = text.replace(/\r\n?/g, "\n").split("\n");
    const blocks: Block[] = [];
    let index = 0;

    while (index < lines.length) {
      if (lines[index] === "") {
        index += 1;
        continue;
      }

      const fence = lines[index]?.match(fencePattern);
      if (fence) {
        let close = index + 1;
        while (close < lines.length && !closingFencePattern.test(lines[close]!)) close += 1;
        if (close === lines.length) {
          // Deliberately fall through while streaming; this flips to <pre> once the closing fence arrives.
        } else {
          blocks.push({
            type: "code",
            language: fence[1]?.trim() ?? "",
            text: lines.slice(index + 1, close).join("\n"),
          });
          index = close + 1;
          continue;
        }
      }

      const heading = lines[index]?.match(headingPattern);
      if (heading) {
        blocks.push({
          type: "heading",
          level: heading[1]!.length as 1 | 2 | 3,
          spans: parseInline(heading[2]!),
        });
        index += 1;
        continue;
      }

      const firstItem = lines[index]?.match(listPattern);
      if (firstItem) {
        const ordered = firstItem[1] !== undefined;
        const start = ordered ? Number(firstItem[1]) : undefined;
        const items: InlineSpan[][] = [];
        while (index < lines.length) {
          const item = lines[index]?.match(listPattern);
          if (!item || (item[1] !== undefined) !== ordered) {
            if (lines[index] === "" && index + 1 < lines.length) {
              const nextItem = lines[index + 1]?.match(listPattern);
              if (nextItem && (nextItem[1] !== undefined) === ordered) {
                index += 1;
                continue;
              }
            }
            break;
          }
          items.push(parseInline(item[3]!));
          index += 1;
        }
        blocks.push({ type: "list", ordered, ...(start === undefined ? {} : { start }), items });
        continue;
      }

      const paragraph: string[] = [];
      while (index < lines.length && lines[index] !== "") {
        if (paragraph.length > 0 && isBlockStart(lines[index]!)) break;
        paragraph.push(lines[index]!);
        index += 1;
      }
      blocks.push({ type: "paragraph", spans: parseInline(paragraph.join("\n")) });
    }
    return blocks;
  } catch {
    return [{ type: "paragraph", spans: [{ type: "text", text }] }];
  }
}

/** The text users can actually see, with one newline between blocks/list items. */
export function plainTextOf(blocks: readonly Block[]): string {
  return blocks.flatMap((block) => {
    if (block.type === "code") return [block.text];
    if (block.type === "list") return block.items.map((item) => item.map((span) => span.text).join(""));
    return [block.spans.map((span) => span.text).join("")];
  }).join("\n");
}

function isBlockStart(line: string): boolean {
  return headingPattern.test(line) || listPattern.test(line) || fencePattern.test(line);
}

function parseInline(text: string): InlineSpan[] {
  const spans: InlineSpan[] = [];
  let plain = "";
  const flush = () => {
    if (plain) spans.push({ type: "text", text: plain });
    plain = "";
  };

  for (let index = 0; index < text.length;) {
    // A link label cannot begin with another opener in this deliberately flat subset.
    // Skipping runs of `[` avoids retrying the bounded link regexp at every byte.
    if (text[index] === "[" && text[index + 1] !== "[") {
      linkPattern.lastIndex = index;
      const link = linkPattern.exec(text);
      if (link) {
        flush();
        spans.push({ type: "link", text: link[1]!, href: link[2]! });
        index = linkPattern.lastIndex;
        continue;
      }
    }

    const marker = text.startsWith("**", index) ? "**" : text[index] === "`" ? "`" : text[index] === "*" ? "*" : null;
    if (marker) {
      const end = text.indexOf(marker, index + marker.length);
      const content = end === -1 ? "" : text.slice(index + marker.length, end);
      const flanked = marker === "`" || (content.length > 0 && !/^\s|\s$/.test(content));
      if (end !== -1 && content && !content.includes("\n") && flanked) {
        flush();
        spans.push({
          type: marker === "**" ? "bold" : marker === "*" ? "italic" : "code",
          text: content,
        });
        index = end + marker.length;
        continue;
      }
    }

    plain += text[index];
    index += 1;
  }
  flush();
  return spans;
}

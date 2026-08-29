export type InlineSpan =
  | { type: "text"; text: string }
  | { type: "bold" | "italic" | "code"; text: string }
  | { type: "link"; text: string; href: string };

export type Block =
  | { type: "paragraph"; spans: InlineSpan[] }
  | { type: "heading"; level: 1 | 2 | 3; spans: InlineSpan[] }
  | { type: "list"; ordered: boolean; items: InlineSpan[][] }
  | { type: "code"; language: string; text: string };

const headingPattern = /^(#{1,3})[ \t]+(.+)$/;
const listPattern = /^\s*(?:(\d+)\.|([-*]))[ \t]+(.+)$/;
const fencePattern = /^```([^`]*)$/;

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
        const close = lines.indexOf("```", index + 1);
        if (close !== -1) {
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
        const items: InlineSpan[][] = [];
        while (index < lines.length) {
          const item = lines[index]?.match(listPattern);
          if (!item) break;
          items.push(parseInline(item[3]!));
          index += 1;
        }
        blocks.push({ type: "list", ordered, items });
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
    const rest = text.slice(index);
    const link = rest.match(/^\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/);
    if (link) {
      flush();
      spans.push({ type: "link", text: link[1]!, href: link[2]! });
      index += link[0].length;
      continue;
    }

    const marker = rest.startsWith("**") ? "**" : rest[0] === "`" ? "`" : rest[0] === "*" ? "*" : null;
    if (marker) {
      const end = text.indexOf(marker, index + marker.length);
      const content = end === -1 ? "" : text.slice(index + marker.length, end);
      if (end !== -1 && content && !content.includes("\n")) {
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

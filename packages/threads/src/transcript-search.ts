import type { TranscriptItem } from "./transcript-items.js";
import type { WorkEntry } from "./transcript-items.js";
import { plainTextOf, renderLightMarkdown } from "./light-markdown.js";

export interface SearchHit {
  itemId: string;
  turnId: string;
  field: "text" | "title" | "entry";
  entryIndex?: number;
  start: number;
  end: number;
}

function turnIdOf(item: TranscriptItem): string {
  if ("runId" in item) return item.runId;
  return item.id.slice(0, item.id.lastIndexOf(":"));
}

function appendHits(
  hits: SearchHit[],
  item: TranscriptItem,
  query: string,
  field: SearchHit["field"],
  value: string,
  entryIndex?: number,
) {
  // Deliberate Unicode-default/ASCII-style folding: stable across user locales.
  const haystack = value.toLowerCase();
  let start = 0;
  while (start <= haystack.length - query.length) {
    const match = haystack.indexOf(query, start);
    if (match < 0) break;
    hits.push({
      itemId: item.id,
      turnId: turnIdOf(item),
      field,
      ...(entryIndex === undefined ? {} : { entryIndex }),
      start: match,
      end: match + query.length,
    });
    start = match + query.length;
  }
}

export function workEntryText(entry: WorkEntry): string {
  return entry.input + (entry.result != null ? `\n\n— result —\n${entry.result || "(empty)"}` : "");
}

function isBareFailureCode(item: Extract<TranscriptItem, { kind: "turn-end" }>): boolean {
  return !item.ok && /^[a-z0-9]+(?:_[a-z0-9]+)+$/.test(item.resultText);
}

/** Case-insensitive transcript search in stable visual order. */
export function searchTranscript(
  items: readonly TranscriptItem[],
  query: string,
  options: { excludeQuestions?: boolean } = {},
): SearchHit[] {
  if (!query.trim()) return [];
  const needle = query.toLowerCase();
  const hits: SearchHit[] = [];
  for (const item of items) {
    switch (item.kind) {
      case "user":
      case "system":
      case "notice":
      case "kickoff":
        appendHits(hits, item, needle, "text", item.text);
        break;
      case "assistant":
        appendHits(hits, item, needle, "text", plainTextOf(renderLightMarkdown(item.text)));
        break;
      case "question":
        if (!options.excludeQuestions) appendHits(hits, item, needle, "text", item.text);
        break;
      case "turn-end":
        if (!isBareFailureCode(item)) appendHits(hits, item, needle, "text", item.resultText);
        break;
      case "work":
        appendHits(hits, item, needle, "title", item.title);
        item.entries.forEach((entry, entryIndex) => {
          appendHits(hits, item, needle, "entry", workEntryText(entry), entryIndex);
        });
        break;
    }
  }
  return hits;
}

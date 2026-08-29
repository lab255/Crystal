import type { TranscriptItem } from "./transcript-items.js";
import type { WorkEntry } from "./transcript-items.js";
import { plainTextOf, renderLightMarkdown } from "./light-markdown.js";

export interface SearchHit {
  itemId: string;
  turnId: string;
  field: "text" | "thinking" | "title" | "entry";
  entryIndex?: number;
  start: number;
  end: number;
}

function hitKey(hit: SearchHit): string {
  return `${hit.itemId}:${hit.field}:${hit.entryIndex ?? ""}:${hit.start}`;
}

/** Preserve a selected match as search results are reordered or removed. */
export function resolveActiveHit(
  hits: readonly SearchHit[],
  preservedKey: string | null,
  current: number,
): { index: number; key: string | null } {
  if (!hits.length) return { index: 0, key: null };
  const preservedIndex = preservedKey == null
    ? -1
    : hits.findIndex((hit) => hitKey(hit) === preservedKey);
  const index = preservedIndex >= 0
    ? preservedIndex
    : Math.max(0, Math.min(current, hits.length - 1));
  return { index, key: hitKey(hits[index]!) };
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
        if (item.thinking) appendHits(hits, item, needle, "thinking", item.thinking);
        break;
      case "delegation":
        appendHits(hits, item, needle, "title", item.headline);
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

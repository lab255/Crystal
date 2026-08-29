import type { TranscriptItem } from "./transcript-items.js";

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
  const haystack = value.toLocaleLowerCase();
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

/** Case-insensitive transcript search in stable visual order. */
export function searchTranscript(items: readonly TranscriptItem[], query: string): SearchHit[] {
  if (!query) return [];
  const needle = query.toLocaleLowerCase();
  const hits: SearchHit[] = [];
  for (const item of items) {
    switch (item.kind) {
      case "user":
      case "assistant":
      case "system":
      case "notice":
      case "kickoff":
      case "question":
        appendHits(hits, item, needle, "text", item.text);
        break;
      case "turn-end":
        appendHits(hits, item, needle, "text", item.resultText);
        break;
      case "work":
        appendHits(hits, item, needle, "title", item.title);
        item.entries.forEach((entry, entryIndex) => {
          const expandedText = [entry.name, entry.title, entry.input, entry.result]
            .filter((value): value is string => value != null)
            .join("\n");
          appendHits(hits, item, needle, "entry", expandedText, entryIndex);
        });
        break;
    }
  }
  return hits;
}

import { describe, expect, it } from "vitest";
import type { TranscriptItem } from "./transcript-items.js";
import { searchTranscript } from "./transcript-search.js";

describe("searchTranscript", () => {
  const items: TranscriptItem[] = [
    { kind: "user", id: "r1:user", runId: "r1", text: "Alpha then alpha", ts: "" },
    {
      kind: "work", id: "r1:work", title: "Explored alpha", hasError: false, pending: false,
      entries: [{ toolUseId: "t1", name: "Read", title: "Read hidden.txt", input: "{\"term\":\"ALPHA\"}", result: "alpha result", isError: false }],
    },
    { kind: "system", id: "r2:system", status: "failed", text: "Final alpha", tone: "warn" },
  ];

  it("returns multiple hits in transcript and field order", () => {
    expect(searchTranscript(items, "alpha").map(({ itemId, field, entryIndex, start }) =>
      [itemId, field, entryIndex, start])).toEqual([
      ["r1:user", "text", undefined, 0],
      ["r1:user", "text", undefined, 11],
      ["r1:work", "title", undefined, 9],
      ["r1:work", "entry", 0, 30],
      ["r1:work", "entry", 0, 38],
      ["r2:system", "text", undefined, 6],
    ]);
  });

  it("is case insensitive", () => {
    expect(searchTranscript(items, "aLpHa")).toHaveLength(6);
  });

  it("returns no hits for an empty query", () => {
    expect(searchTranscript(items, "")).toEqual([]);
  });

  it("finds expanded data while work entries are visually collapsed", () => {
    const hits = searchTranscript(items, "hidden.txt");
    expect(hits).toMatchObject([{ itemId: "r1:work", field: "entry", entryIndex: 0 }]);
  });
});

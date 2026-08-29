import { describe, expect, it } from "vitest";
import type { TranscriptItem } from "./transcript-items.js";
import { resolveActiveHit, searchTranscript, workEntryText } from "./transcript-search.js";

describe("resolveActiveHit", () => {
  const hit = (itemId: string, start: number) => ({
    itemId, turnId: itemId, field: "text" as const, start, end: start + 1,
  });

  it("keeps the active hit across a reorder", () => {
    const first = hit("first", 0);
    const active = hit("active", 2);
    expect(resolveActiveHit([active, first], "active:text::2", 1)).toEqual({
      index: 0,
      key: "active:text::2",
    });
  });

  it("clamps the active index when hits shrink", () => {
    expect(resolveActiveHit([hit("only", 0)], "removed:text::0", 3)).toEqual({
      index: 0,
      key: "only:text::0",
    });
  });

  it("returns zero when there are no hits", () => {
    expect(resolveActiveHit([], "removed:text::0", 2)).toEqual({ index: 0, key: null });
  });
});

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
      ["r1:work", "entry", 0, 9],
      ["r1:work", "entry", 0, 29],
      ["r2:system", "text", undefined, 6],
    ]);
  });

  it("is case insensitive", () => {
    expect(searchTranscript(items, "aLpHa")).toHaveLength(6);
  });

  it("returns no hits for an empty query", () => {
    expect(searchTranscript(items, "")).toEqual([]);
    expect(searchTranscript(items, "   ")).toEqual([]);
  });

  it("searches assistant rendered text rather than markdown syntax and hrefs", () => {
    const assistant: TranscriptItem[] = [
      { kind: "assistant", id: "r1:a", text: "[docs](https://docs.x) al**pha**", thinking: null },
    ];
    expect(searchTranscript(assistant, "docs")).toMatchObject([{ start: 0, end: 4 }]);
    expect(searchTranscript(assistant, "alpha")).toMatchObject([{ start: 5, end: 10 }]);
    expect(searchTranscript(assistant, "https")).toEqual([]);
  });

  it("searches assistant thinking and worker delegation purpose", () => {
    const extra: TranscriptItem[] = [
      { kind: "assistant", id: "r1:a", text: "Visible", thinking: "Consider the hidden edge" },
      { kind: "delegation", id: "r1:d", headline: "Audit the payment worker", worker: null },
    ];
    expect(searchTranscript(extra, "hidden")).toMatchObject([{ field: "thinking", start: 13 }]);
    expect(searchTranscript(extra, "payment")).toMatchObject([{ field: "title", start: 10 }]);
  });

  it("uses the displayed work-entry body", () => {
    expect(workEntryText(items[1]!.kind === "work" ? items[1]!.entries[0]! : (() => { throw new Error(); })()))
      .toBe('{"term":"ALPHA"}\n\n— result —\nalpha result');
  });

  it("excludes text that the row cannot highlight", () => {
    const hidden: TranscriptItem[] = [
      { kind: "turn-end", id: "r1:end", runId: "r1", status: "failed", ok: false, resultText: "rate_limit", costUsd: null, durationMs: null },
      { kind: "question", id: "r1:q", runId: "r1", text: "Secret question", options: [], recommended: null, record: null },
    ];
    expect(searchTranscript(hidden, "rate_limit")).toEqual([]);
    expect(searchTranscript(hidden, "secret", { excludeQuestions: true })).toEqual([]);
  });

  it("finds expanded preformatted data while work entries are visually collapsed", () => {
    const hits = searchTranscript(items, "term");
    expect(hits).toMatchObject([{ itemId: "r1:work", field: "entry", entryIndex: 0 }]);
  });
});

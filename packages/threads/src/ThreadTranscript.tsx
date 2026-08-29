import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Brain,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CircleHelp,
  CircleX,
  GitBranch,
  History,
  Link,
  Search,
} from "lucide-react";
import { formatRunCost, formatRunDuration } from "@crystal/client";
import { Badge, Spinner, StatusDot, cn } from "@crystal/ui";
import { renderLightMarkdown, type InlineSpan } from "./light-markdown.js";
import type { TranscriptItem, WorkEntry } from "./transcript-items.js";
import { TranscriptFindBar } from "./TranscriptFindBar.js";
import { resolveActiveHit, searchTranscript, workEntryText, type SearchHit } from "./transcript-search.js";

type IndexedHit = SearchHit & { index: number };
const NO_HITS: readonly IndexedHit[] = [];
const EMPTY_HITS_BY_ITEM = new Map<string, IndexedHit[]>();

function hitKey(hit: SearchHit): string {
  return `${hit.itemId}:${hit.field}:${hit.entryIndex ?? ""}:${hit.start}`;
}

export interface QuestionAnswerResult {
  notice?: string;
}

/**
 * The chat transcript: renders the items `buildTranscriptItems` folded.
 * Purely presentational — answering, permission decisions and worker
 * expansion arrive as callbacks so the same renderer serves workspace
 * threads, nested workers and the program-manager chat.
 */
export function ThreadTranscript({
  items,
  threadId,
  /** Render the answering surface for a pending question item. */
  renderQuestion,
  /** Render an expanded worker's nested transcript (delegation rows). */
  renderWorker,
  /** Fetch a collapsed turn's events (the row shows a spinner meanwhile). */
  onExpandTurn,
  focusTurnId,
  onCopyTurnLink,
  onFocusedTurn,
  /** Live thread: show the working shimmer under the last item. */
  working = false,
  findDisabled = false,
  className,
}: {
  items: readonly TranscriptItem[];
  /** Scroll state is per-thread; switching threads re-follows the tail. */
  threadId: string;
  renderQuestion?: (item: Extract<TranscriptItem, { kind: "question" }>) => ReactNode;
  renderWorker?: (item: Extract<TranscriptItem, { kind: "delegation" }>) => ReactNode;
  onExpandTurn?: (runId: string) => void | Promise<void>;
  /** Scroll to and briefly highlight a turn once its rows are rendered. */
  focusTurnId?: string;
  /** When supplied, exposes a per-turn copy-link action. */
  onCopyTurnLink?: (runId: string) => void | Promise<void>;
  onFocusedTurn?: (runId: string) => void;
  working?: boolean;
  /** Nested transcripts defer find shortcuts and UI to their top-level transcript. */
  findDisabled?: boolean;
  className?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const findInputRef = useRef<HTMLInputElement>(null);
  const stickToBottom = useRef(true);
  const lastFocused = useRef<string | null>(null);
  const focusedRef = useRef<string | undefined>(focusTurnId);
  const lastFocusedOffset = useRef<number | null>(null);
  const focusScrollUntil = useRef(0);
  const [highlightedTurnId, setHighlightedTurnId] = useState<string | null>(null);
  const [keyboardTurn, setKeyboardTurn] = useState(-1);
  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeHit, setActiveHit] = useState(0);
  const [loadingAll, setLoadingAll] = useState(false);
  const activeKeyRef = useRef<string | null>(null);
  const hits = useMemo(
    () => searchTranscript(items, query, { excludeQuestions: renderQuestion != null }),
    [items, query, renderQuestion],
  );
  const hitsByItem = useMemo(() => {
    if (!findOpen || !query.trim()) return EMPTY_HITS_BY_ITEM;
    const grouped = new Map<string, IndexedHit[]>();
    hits.forEach((hit, index) => {
      const itemHits = grouped.get(hit.itemId) ?? [];
      if (!grouped.has(hit.itemId)) grouped.set(hit.itemId, itemHits);
      itemHits.push({ ...hit, index });
    });
    return grouped;
  }, [hits, findOpen, query]);
  const activeKey = hits[activeHit] ? hitKey(hits[activeHit]!) : null;
  const unloadedTurns = useMemo(
    () => items.filter((item): item is Extract<TranscriptItem, { kind: "collapsed-turn" }> => item.kind === "collapsed-turn"),
    [items],
  );
  const turns = useMemo(() => groupItemsByTurn(items), [items]);
  const active = keyboardTurn < turns.length ? keyboardTurn : -1;
  const ownTurnRows = () => Array.from(
    scrollRef.current?.querySelectorAll<HTMLElement>("[data-turn-id]") ?? [],
  ).filter((element) => element.closest("[data-transcript]") === scrollRef.current);

  const closeFind = () => {
    setFindOpen(false);
    // Closing find must not silently resume tail-follow after the user navigated away.
    requestAnimationFrame(() => scrollRef.current?.focus());
  };
  const cycleHit = (delta: number) => {
    if (!hits.length) return;
    setActiveHit((current) => {
      const next = (current + delta + hits.length) % hits.length;
      activeKeyRef.current = hitKey(hits[next]!);
      return next;
    });
  };

  useEffect(() => {
    setActiveHit(0);
    activeKeyRef.current = null;
  }, [query]);

  useEffect(() => {
    setActiveHit((current) => {
      const resolved = resolveActiveHit(hits, activeKeyRef.current, current);
      activeKeyRef.current = resolved.key;
      return resolved.index;
    });
  }, [hits]);

  useEffect(() => {
    if (!findOpen) return;
    requestAnimationFrame(() => findInputRef.current?.focus());
  }, [findOpen]);

  useEffect(() => {
    if (!findOpen || !hits[activeHit]) return;
    stickToBottom.current = false;
    const frame = requestAnimationFrame(() => {
      containerRef.current?.querySelector<HTMLElement>(`[data-search-hit="${activeHit}"]`)
        ?.scrollIntoView({ block: "center", behavior: "auto" });
    });
    return () => cancelAnimationFrame(frame);
  }, [activeKey, activeHit, findOpen]);

  useEffect(() => {
    focusedRef.current = focusTurnId;
    if (focusTurnId === undefined) lastFocused.current = null;
  }, [focusTurnId]);

  const moveKeyboardFocus = (index: number) => {
    const next = Math.max(0, Math.min(turns.length - 1, index));
    setKeyboardTurn(next);
    ownTurnRows()[next]?.focus();
  };

  useEffect(() => {
    stickToBottom.current = true;
    setKeyboardTurn(-1);
    setFindOpen(false);
    setQuery("");
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [threadId]);

  // Key the tail-follow on `items` (a fresh array per fold), not its length:
  // streamed text merges into the LAST item in place (assistant prose,
  // work-entry growth), so length alone misses in-place growth.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
    const focusedTurnId = focusedRef.current;
    if (!focusedTurnId || lastFocused.current !== `${threadId}:${focusedTurnId}`) return;
    if (Date.now() >= focusScrollUntil.current) return;
    const target = Array.from(
      ownTurnRows(),
    ).find((element) => element.dataset.turnId === focusedTurnId);
    if (!target || target.offsetTop === lastFocusedOffset.current) return;
    lastFocusedOffset.current = target.offsetTop;
    target.scrollIntoView({ block: "start", behavior: "auto" });
  }, [items, threadId, working]);

  useEffect(() => {
    if (!focusTurnId || lastFocused.current === `${threadId}:${focusTurnId}`) return;
    if (!turns.some((turn) => turn.runId === focusTurnId)) return;
    const target = Array.from(
      ownTurnRows(),
    ).find((element) => element.dataset.turnId === focusTurnId);
    if (!target) return;
    lastFocused.current = `${threadId}:${focusTurnId}`;
    lastFocusedOffset.current = target.offsetTop;
    focusScrollUntil.current = Date.now() + 1_000;
    stickToBottom.current = false;
    // Ignore scroll events while the focused turn grows, or tail-follow can win the race.
    target.scrollIntoView({ block: "start", behavior: "auto" });
    setHighlightedTurnId(focusTurnId);
  }, [focusTurnId, items, threadId, turns]);

  useEffect(() => {
    if (!highlightedTurnId) return;
    const timer = window.setTimeout(() => {
      setHighlightedTurnId(null);
      onFocusedTurn?.(highlightedTurnId);
    }, 2_500);
    return () => window.clearTimeout(timer);
  }, [highlightedTurnId, onFocusedTurn]);

  return (
    <div
      ref={containerRef}
      className={cn("relative flex min-h-0 flex-1 flex-col", className)}
      onKeyDownCapture={(event) => {
        const target = event.target as HTMLElement;
        if (findDisabled || !(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "f") return;
        if (target.closest(".xterm")) return;
        event.preventDefault();
        event.stopPropagation();
        setFindOpen(true);
      }}
    >
      {!findDisabled && findOpen ? (
        <TranscriptFindBar
          query={query}
          onQueryChange={setQuery}
          activeIndex={activeHit}
          hitCount={hits.length}
          unloadedCount={unloadedTurns.length}
          onPrevious={() => cycleHit(-1)}
          onNext={() => cycleHit(1)}
          onClose={closeFind}
          loadingAll={loadingAll}
          onLoadAll={onExpandTurn ? async () => {
            setLoadingAll(true);
            try {
              await Promise.all(unloadedTurns.map((item) => onExpandTurn(item.runId)));
            } finally {
              setLoadingAll(false);
            }
          } : undefined}
          inputRef={findInputRef}
        />
      ) : !findDisabled ? (
        <button
          type="button"
          aria-label="Find in thread"
          title="Find in thread"
          onClick={() => setFindOpen(true)}
          className="absolute right-3 top-2 z-20 rounded bg-surface-1/90 p-1.5 text-ink-faint shadow-sm hover:bg-surface-2 hover:text-ink"
        >
          <Search className="h-3.5 w-3.5" />
        </button>
      ) : null}
      <div
      ref={scrollRef}
      data-transcript="true"
      tabIndex={active < 0 ? 0 : -1}
      onFocus={(event) => {
        if (event.target === event.currentTarget) setKeyboardTurn(-1);
      }}
      onKeyDown={(event) => {
        const target = event.target as HTMLElement;
        if (target !== event.currentTarget && !target.hasAttribute("data-turn-id")) return;
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          event.stopPropagation();
          moveKeyboardFocus(active + (event.key === "ArrowDown" ? 1 : -1));
          return;
        }
        if ((event.key === "Enter" || event.key === " ") && active >= 0) {
          const row = ownTurnRows()[active];
          const toggle = row?.querySelector<HTMLButtonElement>(
            'button[aria-expanded], button[data-row-toggle="true"]',
          );
          if (toggle && event.target === row) {
            event.preventDefault();
            event.stopPropagation();
            toggle.click();
          }
        }
      }}
      onScroll={(e) => {
        if (Date.now() < focusScrollUntil.current) return;
        const el = e.currentTarget;
        stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
      }}
      className="min-h-0 flex-1 space-y-2 overflow-y-auto px-4 py-3"
    >
      {turns.map((turn, index) => (
        <div
          key={turn.runId}
          data-turn-id={turn.runId}
          role="group"
          aria-label={`Turn ${index + 1}`}
          tabIndex={active === index ? 0 : -1}
          className={cn(
            "group/turn relative space-y-2 rounded-lg border-l-2 border-transparent pr-7",
            "transition-colors duration-500",
            highlightedTurnId === turn.runId
              && "border-l-accent-blue bg-accent-blue/10 ring-2 ring-accent-blue/40",
          )}
        >
          {onCopyTurnLink ? (
            <button
              type="button"
              tabIndex={-1}
              aria-label="Copy link to turn"
              title={`Copy link to turn ${index + 1}`}
              onClick={() => void onCopyTurnLink(turn.runId)}
              className={cn(
                "absolute right-1 top-1 z-10 rounded p-1 text-ink-faint opacity-0",
                "hover:bg-surface-2 hover:text-ink group-hover/turn:opacity-100",
                "focus-visible:opacity-100",
              )}
            >
              <Link className="h-3 w-3" />
            </button>
          ) : null}
          {turn.items.map((item) => (
            <TranscriptItemRow
              key={item.id}
              item={item}
              focusTurnId={focusTurnId}
              renderQuestion={renderQuestion}
              renderWorker={renderWorker}
              onExpandTurn={onExpandTurn}
              hits={hitsByItem.get(item.id) ?? NO_HITS}
              activeHit={(hitsByItem.get(item.id) ?? NO_HITS).some((hit) => hit.index === activeHit) ? activeHit : -1}
            />
          ))}
        </div>
      ))}
      {working ? (
        <div className="flex items-center gap-2 px-1 text-xs text-ink-muted">
          <Spinner className="h-3.5 w-3.5" /> Working…
        </div>
      ) : null}
      </div>
    </div>
  );
}

function itemTurnId(item: TranscriptItem): string {
  if ("runId" in item) return item.runId;
  // Transcript item ids follow the `${turnId}:${seq}` contract from transcript-items.ts.
  return item.id.slice(0, item.id.lastIndexOf(":"));
}

function groupItemsByTurn(items: readonly TranscriptItem[]) {
  const groups: Array<{ runId: string; items: TranscriptItem[] }> = [];
  for (const item of items) {
    const runId = itemTurnId(item);
    const tail = groups[groups.length - 1];
    if (tail?.runId === runId) tail.items.push(item);
    else groups.push({ runId, items: [item] });
  }
  return groups;
}

function TranscriptItemRow({
  item,
  focusTurnId,
  renderQuestion,
  renderWorker,
  onExpandTurn,
  hits,
  activeHit,
}: {
  item: TranscriptItem;
  focusTurnId?: string;
  renderQuestion?: (item: Extract<TranscriptItem, { kind: "question" }>) => ReactNode;
  renderWorker?: (item: Extract<TranscriptItem, { kind: "delegation" }>) => ReactNode;
  onExpandTurn?: (runId: string) => void | Promise<void>;
  hits: readonly IndexedHit[];
  activeHit: number;
}) {
  const itemHits = hits;
  switch (item.kind) {
    case "user":
      return <UserRow text={item.text} hits={itemHits} activeHit={activeHit} />;
    case "kickoff":
      return <ExpandableNotice label="Kickoff brief" text={item.text} hits={itemHits} activeHit={activeHit} />;
    case "notice":
      return <ExpandableNotice label="Crystal" text={item.text} hits={itemHits} activeHit={activeHit} />;
    case "assistant":
      return <AssistantRow text={item.text} thinking={item.thinking} hits={itemHits} activeHit={activeHit} />;
    case "work":
      return <WorkRow item={item} hits={itemHits} activeHit={activeHit} />;
    case "question":
      return <QuestionRow item={item} renderQuestion={renderQuestion} hits={itemHits} activeHit={activeHit} />;
    case "delegation":
      return (
        <DelegationRow
          item={item}
          focusTurnId={focusTurnId}
          renderWorker={renderWorker}
          hits={itemHits}
          activeHit={activeHit}
        />
      );
    case "permission":
      return (
        <div
          className={cn(
            "flex items-start gap-2 rounded-lg border px-3 py-2 text-xs leading-relaxed text-ink",
            item.state === "pending"
              ? "border-warn/30 bg-warn/10"
              : item.state === "allowed"
                ? "border-ok/25 bg-ok/8"
                : item.state === "expired"
                  ? "border-edge bg-surface-2"
                  : "border-danger/25 bg-danger/8",
          )}
        >
          <CircleHelp
            className={cn(
              "mt-0.5 h-3.5 w-3.5 shrink-0",
              item.state === "pending"
                ? "text-warn"
                : item.state === "allowed"
                  ? "text-ok"
                  : item.state === "expired" ? "text-ink-faint" : "text-danger",
            )}
          />
          <span className="whitespace-pre-wrap">
            {item.state === "pending"
              ? `Waiting for permission: ${item.detail ?? item.tool}`
              : item.state === "expired"
                ? `Permission expired: ${item.detail ?? item.tool}`
                : `Permission ${item.state}: ${item.detail ?? item.tool}`}
          </span>
        </div>
      );
    case "turn-end":
      const bareFailureCode = !item.ok && /^[a-z0-9]+(?:_[a-z0-9]+)+$/.test(item.resultText);
      const outcome = item.status === "cancelled" ? "Turn cancelled" : "Turn failed";
      return (
        <div
          className="flex items-center gap-2 px-1 text-[10px] text-ink-faint"
          title={bareFailureCode ? `${outcome} — ${item.resultText}` : undefined}
        >
          {item.ok ? (
            <CircleCheck className="h-3 w-3 text-ok" />
          ) : (
            <CircleX className="h-3 w-3 text-danger" />
          )}
          <span className={cn(!item.ok && "text-danger")}>
            {item.ok
              ? item.resultText
                ? <>Turn settled — {highlightText(item.resultText, itemHits, activeHit)}</>
                : "Turn settled"
              : bareFailureCode || !item.resultText
                ? outcome
                : <>{outcome} — {highlightText(item.resultText, itemHits, activeHit)}</>}
          </span>
          <span>·</span>
          <span>{formatRunCost(item.costUsd)}</span>
          <span>·</span>
          <span>{formatRunDuration(item.durationMs)}</span>
        </div>
      );
    case "system":
      return (
        <div
          className={cn(
            "px-1 text-[10px]",
            item.tone === "warn" ? "text-warn" : "text-ink-faint",
          )}
        >
          {highlightText(item.text, itemHits, activeHit)}
        </div>
      );
    case "collapsed-turn":
      return <CollapsedTurnRow item={item} onExpandTurn={onExpandTurn} />;
    default:
      return null;
  }
}

function ExpandableNotice({ label, text, hits, activeHit }: { label: string; text: string; hits: readonly IndexedHit[]; activeHit: number }) {
  const [expanded, setExpanded] = useState(false);
  const [firstLine] = text.split("\n");
  const ownsActive = hits.some((hit) => hit.index === activeHit);
  useEffect(() => { if (ownsActive) setExpanded(true); }, [ownsActive]);
  return (
    <div className="flex w-full min-w-0 justify-start">
      <button
        type="button"
        tabIndex={-1}
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        title={expanded ? undefined : firstLine}
        className="w-full min-w-0 max-w-[90%] rounded-lg border border-edge bg-surface-2 px-3 py-2 text-left"
      >
        {expanded ? (
          <span className="block">
            <span className="block text-[10px] font-semibold text-ink-muted">{label}</span>
            <span className="mt-1 block whitespace-pre-wrap text-xs text-ink">{highlightText(text, hits, activeHit)}</span>
          </span>
        ) : (
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="shrink-0 text-[10px] font-semibold text-ink-muted">{label}</span>
            <span className="min-w-0 flex-1 truncate text-xs text-ink">{firstLine}</span>
          </span>
        )}
      </button>
    </div>
  );
}

function UserRow({ text, hits, activeHit }: { text: string; hits: readonly IndexedHit[]; activeHit: number }) {
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const textRef = useRef<HTMLSpanElement>(null);
  const ownsActive = activeHit !== -1;
  useEffect(() => { if (ownsActive) setExpanded(true); }, [ownsActive]);
  useLayoutEffect(() => {
    const element = textRef.current;
    if (!element || expanded) return;
    const measure = () => setOverflowing(element.scrollHeight > element.clientHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [expanded, text]);
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%]">
        <div
          className={cn(
            "whitespace-pre-wrap rounded-xl rounded-br-sm bg-crystal-500/12",
            "px-3.5 py-2 text-xs leading-relaxed text-ink",
          )}
        >
          <span ref={textRef} className={cn("block", !expanded && "line-clamp-6")}>
            {highlightText(text, hits, activeHit)}
          </span>
        </div>
        {overflowing ? (
          <button
            type="button"
            data-row-toggle="true"
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
            className="mt-0.5 px-1 text-[10px] text-ink-muted hover:text-ink"
          >
            {expanded ? "Show less" : "Show more"}
          </button>
        ) : null}
      </div>
    </div>
  );
}

const AssistantRow = memo(function AssistantRow({ text, thinking, hits, activeHit }: { text: string; thinking: string | null; hits: readonly IndexedHit[]; activeHit: number }) {
  const [showThinking, setShowThinking] = useState(false);
  const thinkingHits = useMemo(() => hits.filter((hit) => hit.field === "thinking"), [hits]);
  const textHits = useMemo(() => hits.filter((hit) => hit.field === "text"), [hits]);
  useEffect(() => {
    if (thinkingHits.some((hit) => hit.index === activeHit)) setShowThinking(true);
  }, [activeHit, thinkingHits]);
  return (
    <div className="max-w-[92%]">
      {thinking ? (
        <button
          type="button"
          onClick={() => setShowThinking((v) => !v)}
          className="mb-1 flex items-center gap-1.5 px-1 text-[10px] italic text-ink-faint hover:text-ink-muted"
        >
          <Brain className="h-3 w-3" /> {showThinking ? "Hide thinking" : "Thought for a while…"}
        </button>
      ) : null}
      {showThinking && thinking ? (
        <div className="mb-1.5 whitespace-pre-wrap rounded-lg border border-edge/70 bg-surface-1 px-3 py-2 text-[11px] italic leading-relaxed text-ink-faint">
          {highlightText(thinking, thinkingHits, activeHit)}
        </div>
      ) : null}
      <LightMarkdown text={text} hits={textHits} activeHit={activeHit} />
    </div>
  );
});

function LightMarkdown({ text, hits = [], activeHit = -1 }: { text: string; hits?: readonly IndexedHit[]; activeHit?: number }) {
  const blocks = useMemo(() => renderLightMarkdown(text), [text]);
  const runningOffset = { current: 0 };
  const separator = () => { runningOffset.current += 1; };
  return (
    <div className="space-y-2 px-1 text-xs leading-relaxed text-ink">
      {blocks.map((block, index) => {
        const key = `${block.type}:${index}`;
        switch (block.type) {
          case "paragraph":
            { const content = renderInline(block.spans, hits, activeHit, runningOffset); separator(); return <p key={key} className="whitespace-pre-wrap">{content}</p>; }
          case "heading": {
            const className = "font-semibold text-ink";
            const content = renderInline(block.spans, hits, activeHit, runningOffset); separator();
            if (block.level === 1) return <h1 key={key} className={className}>{content}</h1>;
            if (block.level === 2) return <h2 key={key} className={className}>{content}</h2>;
            return <h3 key={key} className={className}>{content}</h3>;
          }
          case "list": {
            const List = block.ordered ? "ol" : "ul";
            return (
              <List key={key} start={block.start} className={cn("pl-4", block.ordered ? "list-decimal" : "list-disc")}>
                {block.items.map((item, itemIndex) => { const content = renderInline(item, hits, activeHit, runningOffset); separator(); return <li key={itemIndex}>{content}</li>; })}
              </List>
            );
          }
          case "code": {
            const content = highlightSlice(block.text, runningOffset.current, hits, activeHit);
            runningOffset.current += block.text.length + 1;
            return (
              <pre key={key} className="overflow-x-auto whitespace-pre-wrap rounded bg-surface-2 px-2.5 py-2 font-mono text-[12px] text-ink">
                <code data-language={block.language.slice(0, 32) || undefined}>
                  {content}
                </code>
              </pre>
            );
          }
        }
      })}
    </div>
  );
}

function renderInline(
  spans: readonly InlineSpan[],
  hits: readonly IndexedHit[] = [],
  activeHit = -1,
  runningOffset = { current: 0 },
): ReactNode[] {
  return spans.map((span, index) => {
    const content = highlightSlice(span.text, runningOffset.current, hits, activeHit);
    runningOffset.current += span.text.length;
    switch (span.type) {
      case "text": return <span key={index}>{content}</span>;
      case "bold": return <strong key={index}>{content}</strong>;
      case "italic": return <em key={index}>{content}</em>;
      case "code": return <code key={index} className="rounded bg-surface-2 px-1 font-mono text-[12px]">{content}</code>;
      case "link": return <a key={index} href={span.href} target="_blank" rel="noreferrer noopener" className="underline">{content}</a>;
    }
  });
}

function mark(content: string, hit: IndexedHit, activeHit: number) {
  return (
    <mark
      key={`${hit.index}:${hit.start}`}
      data-search-hit={hit.index}
      className={cn(
        "rounded-sm bg-accent-amber/30 text-ink",
        hit.index === activeHit && "ring-2 ring-accent-amber",
      )}
    >
      {content}
    </mark>
  );
}

function highlightText(text: string, hits: readonly IndexedHit[], activeHit: number): ReactNode {
  if (!hits.length) return text;
  const parts: ReactNode[] = [];
  let offset = 0;
  for (const hit of hits) {
    if (hit.start < offset || hit.end > text.length) continue;
    if (hit.start > offset) parts.push(text.slice(offset, hit.start));
    parts.push(mark(text.slice(hit.start, hit.end), hit, activeHit));
    offset = hit.end;
  }
  if (offset < text.length) parts.push(text.slice(offset));
  return parts;
}

function highlightSlice(
  text: string,
  baseOffset: number,
  hits: readonly IndexedHit[],
  activeHit: number,
): ReactNode {
  if (!hits.length) return text;
  const parts: ReactNode[] = [];
  let offset = 0;
  for (const hit of hits) {
    const start = Math.max(0, hit.start - baseOffset);
    const end = Math.min(text.length, hit.end - baseOffset);
    if (end <= 0 || start >= text.length || start < offset || end <= start) continue;
    if (start > offset) parts.push(text.slice(offset, start));
    parts.push(mark(text.slice(start, end), hit, activeHit));
    offset = end;
  }
  if (offset < text.length) parts.push(text.slice(offset));
  return parts;
}

function WorkRow({ item, hits, activeHit }: { item: Extract<TranscriptItem, { kind: "work" }>; hits: readonly IndexedHit[]; activeHit: number }) {
  // Errors open loud; routine exploration stays a one-line summary.
  const [open, setOpen] = useState(item.hasError);
  const ownsActiveEntry = hits.some((hit) => hit.index === activeHit && hit.field === "entry");
  useEffect(() => { if (ownsActiveEntry) setOpen(true); }, [ownsActiveEntry]);
  return (
    <div
      className={cn(
        "rounded-lg border",
        item.hasError ? "border-danger/25 bg-danger/5" : "border-edge/70 bg-surface-1",
      )}
    >
      <button
        type="button"
        tabIndex={-1}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-[11px] text-ink-muted"
      >
        {open ? (
          <ChevronDown className="h-3 w-3 shrink-0 text-ink-faint" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0 text-ink-faint" />
        )}
        <span className="min-w-0 flex-1 truncate">
          {item.pending ? <Spinner className="mr-1.5 inline-block h-3 w-3 align-[-2px]" /> : null}
          {highlightText(item.title, hits.filter((hit) => hit.field === "title"), activeHit)}
        </span>
        {item.hasError ? <Badge tone="rose">error</Badge> : null}
      </button>
      {open ? (
        <div className="space-y-1 border-t border-edge/70 px-2.5 py-1.5">
          {item.entries.map((entry, entryIndex) => (
            <WorkEntryRow key={entry.toolUseId} entry={entry} hits={hits.filter((hit) => hit.entryIndex === entryIndex)} activeHit={activeHit} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function WorkEntryRow({ entry, hits, activeHit }: { entry: WorkEntry; hits: readonly IndexedHit[]; activeHit: number }) {
  const [open, setOpen] = useState(entry.isError);
  const ownsActive = hits.some((hit) => hit.index === activeHit);
  useEffect(() => { if (ownsActive) setOpen(true); }, [ownsActive]);
  const searchable = workEntryText(entry);
  return (
    <div>
      <button
        type="button"
        tabIndex={-1}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-[11px]",
          entry.isError ? "text-danger" : "text-ink-muted hover:text-ink",
        )}
      >
        {open ? (
          <ChevronDown className="h-2.5 w-2.5 shrink-0" />
        ) : (
          <ChevronRight className="h-2.5 w-2.5 shrink-0" />
        )}
        <span className="min-w-0 flex-1 truncate font-mono text-[10px]">{entry.title}</span>
        {entry.result === null ? <Spinner className="h-2.5 w-2.5" /> : null}
      </button>
      {open ? (
        <pre className="mt-0.5 max-h-56 overflow-auto whitespace-pre-wrap rounded border border-edge/60 bg-surface-2/60 px-2 py-1.5 font-mono text-[10px] leading-relaxed text-ink-muted">
          {highlightText(searchable, hits, activeHit)}
        </pre>
      ) : null}
    </div>
  );
}

function QuestionRow({
  item,
  renderQuestion,
  hits,
  activeHit,
}: {
  item: Extract<TranscriptItem, { kind: "question" }>;
  renderQuestion?: (item: Extract<TranscriptItem, { kind: "question" }>) => ReactNode;
  hits: readonly IndexedHit[];
  activeHit: number;
}) {
  const answer = item.record?.answer ?? item.answeredByNotice ?? null;
  const answered = answer != null;
  if (!answered && renderQuestion) {
    const custom = renderQuestion(item);
    if (custom) return <>{custom}</>;
  }
  return (
    <div
      className={cn(
        "rounded-lg border px-3 py-2 text-xs leading-relaxed",
        answered ? "border-edge/70 bg-surface-1 text-ink-muted" : "border-warn/30 bg-warn/10 text-ink",
      )}
    >
      <div className="flex items-start gap-2">
        <CircleHelp className={cn("mt-0.5 h-3.5 w-3.5 shrink-0", answered ? "text-ink-faint" : "text-warn")} />
        <div className="min-w-0">
          <span className="whitespace-pre-wrap">{highlightText(item.text, hits, activeHit)}</span>
          {answered ? (
            <div className="mt-1 whitespace-pre-wrap text-[11px] text-ink">
              <span className="font-semibold">Answer:</span> {answer}
            </div>
          ) : (
            <div className="mt-1 text-[10px] text-ink-faint">Waiting for your answer.</div>
          )}
        </div>
      </div>
    </div>
  );
}

function DelegationRow({
  item,
  focusTurnId,
  renderWorker,
  hits,
  activeHit,
}: {
  item: Extract<TranscriptItem, { kind: "delegation" }>;
  focusTurnId?: string;
  renderWorker?: (item: Extract<TranscriptItem, { kind: "delegation" }>) => ReactNode;
  hits: readonly IndexedHit[];
  activeHit: number;
}) {
  const [open, setOpen] = useState(false);
  const worker = item.worker;
  const canExpand = worker != null && renderWorker != null;
  const containsFocus = worker != null
    && focusTurnId != null
    && nodeContainsTurn(worker, focusTurnId);
  useEffect(() => {
    if (containsFocus) setOpen(true);
  }, [containsFocus]);
  return (
    <div className="rounded-lg border border-crystal-500/25 bg-crystal-500/5">
      <button
        type="button"
        tabIndex={-1}
        aria-expanded={open}
        onClick={canExpand ? () => setOpen((o) => !o) : undefined}
        className={cn(
          "flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[11px] text-ink",
          !canExpand && "cursor-default",
        )}
      >
        {canExpand ? (
          open ? (
            <ChevronDown className="h-3 w-3 shrink-0 text-ink-faint" />
          ) : (
            <ChevronRight className="h-3 w-3 shrink-0 text-ink-faint" />
          )
        ) : (
          <GitBranch className="h-3 w-3 shrink-0 text-crystal-300" />
        )}
        {worker ? <StatusDot status={worker.run.status} /> : null}
        <span className="min-w-0 flex-1 truncate">
          <span className="text-ink-faint">Worker · </span>
          {highlightText(item.headline, hits.filter((hit) => hit.field === "title"), activeHit)}
        </span>
        {worker?.run.costUsd != null ? (
          <span className="shrink-0 text-[10px] text-ink-faint">{formatRunCost(worker.run.costUsd)}</span>
        ) : null}
      </button>
      {open && canExpand ? (
        <div className="border-t border-crystal-500/20 pl-3">{renderWorker(item)}</div>
      ) : null}
    </div>
  );
}

type WorkerNode = NonNullable<Extract<TranscriptItem, { kind: "delegation" }>["worker"]>;

function nodeContainsTurn(node: WorkerNode, runId: string): boolean {
  return node.turns.some((turn) => turn.id === runId)
    || node.workers.some((worker) => nodeContainsTurn(worker, runId));
}

function CollapsedTurnRow({
  item,
  onExpandTurn,
}: {
  item: Extract<TranscriptItem, { kind: "collapsed-turn" }>;
  onExpandTurn?: (runId: string) => void | Promise<void>;
}) {
  const [loading, setLoading] = useState(false);
  return (
    <button
      type="button"
      tabIndex={-1}
      data-row-toggle="true"
      disabled={!onExpandTurn || loading}
      onClick={async () => {
        if (!onExpandTurn) return;
        setLoading(true);
        try {
          await onExpandTurn(item.runId);
        } finally {
          setLoading(false);
        }
      }}
      className="flex w-full items-center gap-2 rounded-lg border border-dashed border-edge/70 px-3 py-1.5 text-left text-[11px] text-ink-faint hover:text-ink-muted"
    >
      {loading ? <Spinner className="h-3 w-3" /> : <History className="h-3 w-3" />}
      {item.headline} — show what happened
    </button>
  );
}

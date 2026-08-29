import {
  MANAGER_OPENING,
  MANAGER_PREAMBLE,
  classifyRunFailure,
  engineNoticeKind,
  unwrapOwnerMessage,
  runFailureHint,
  touchedFileFromToolUse,
  type AgentEvent,
  type AgentRun,
  type RunEvent,
  type RunNode,
  type TaskQuestion,
} from "@crystal/core";

/**
 * The chat-density fold over a thread's event stream. A third chunking of the
 * same `RunEvent[]` (beside the console's one-liners and RunTranscript's
 * per-event blocks): conversation rows stay prose, runs of tool work coalesce
 * into one collapsible work item ("Explored 3 files, 1 search"), questions
 * and delegations become first-class rows. Pure — the component renders what
 * this returns, tests assert on it directly.
 */

/** One tool_use (+ paired tool_result) inside a work item. */
export interface WorkEntry {
  toolUseId: string;
  name: string;
  /** Human line for the entry: "Read packages/core/src/agent.ts", "Bash …". */
  title: string;
  /** Pretty-printed input (expanded view). */
  input: string;
  /** Paired result content, once it arrived. */
  result: string | null;
  isError: boolean;
}

export type TranscriptItem =
  | { kind: "user"; id: string; runId: string; text: string; ts: string }
  | { kind: "assistant"; id: string; text: string; thinking: string | null }
  | {
      kind: "work";
      id: string;
      /** Collapsed headline: "Explored 2 files, 1 search · edited a.ts". */
      title: string;
      entries: WorkEntry[];
      hasError: boolean;
      /** True while the last entry still waits on its tool_result (live). */
      pending: boolean;
    }
  | {
      kind: "question";
      id: string;
      runId: string;
      text: string;
      options: string[];
      recommended: string | null;
      /** Board record joined by (runId, text) — carries answer + lifecycle. */
      record: TaskQuestion | null;
    }
  | {
      kind: "delegation";
      id: string;
      /** First line of the worker's prompt. */
      headline: string;
      /** The dispatched worker's session, when it is present in the run list. */
      worker: RunNode | null;
    }
  | {
      kind: "permission";
      id: string;
      tool: string;
      state: "pending" | "allowed" | "denied" | "expired";
      detail: string | null;
    }
  | {
      kind: "turn-end";
      id: string;
      runId: string;
      ok: boolean;
      resultText: string;
      costUsd: number | null;
      durationMs: number | null;
    }
  | { kind: "system"; id: string; text: string; tone: "muted" | "warn" }
  | { kind: "kickoff"; id: string; runId: string; text: string }
  | { kind: "notice"; id: string; runId: string; text: string }
  | {
      /** A turn whose events are not loaded yet — expand to fetch. */
      kind: "collapsed-turn";
      id: string;
      runId: string;
      headline: string;
      ts: string;
    };

/** Tools whose consecutive runs collapse into one "Explored…" summary. */
const READ_TOOLS = new Set([
  "Read",
  "Grep",
  "Glob",
  "LS",
  "WebFetch",
  "WebSearch",
  "NotebookRead",
  "TodoRead",
]);

const SEARCH_TOOLS = new Set(["Grep", "Glob", "WebSearch"]);

function pretty(input: unknown): string {
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

function shortValue(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** One-line human title for a tool call. */
export function workEntryTitle(name: string, input: unknown): string {
  const p = (input as Record<string, unknown> | null | undefined) ?? {};
  const edited = touchedFileFromToolUse(name, input);
  if (edited) return `${name === "Write" ? "Wrote" : "Edited"} ${edited}`;
  if (name === "Read") return `Read ${shortValue(p.file_path) ?? "file"}`;
  if (name === "Grep") return `Searched ${shortValue(p.pattern) ?? ""}`.trim();
  if (name === "Glob") return `Globbed ${shortValue(p.pattern) ?? ""}`.trim();
  if (name === "LS") return `Listed ${shortValue(p.path) ?? "directory"}`;
  if (name === "Bash") {
    const cmd = shortValue(p.command);
    const desc = shortValue(p.description);
    return desc ?? (cmd ? `$ ${cmd.split("\n")[0]}` : "Ran a command");
  }
  if (name === "WebFetch") return `Fetched ${shortValue(p.url) ?? "URL"}`;
  if (name === "WebSearch") return `Searched the web: ${shortValue(p.query) ?? ""}`.trim();
  const hint = shortValue(p.file_path) ?? shortValue(p.path) ?? shortValue(p.pattern);
  return hint ? `${name} ${hint}` : name;
}

/** Collapsed headline for a run of tool work. */
export function workTitle(entries: readonly WorkEntry[]): string {
  const reads = new Set<string>();
  let searches = 0;
  const edits: string[] = [];
  let commands = 0;
  let other = 0;
  for (const entry of entries) {
    if (entry.title.startsWith("Edited ") || entry.title.startsWith("Wrote ")) {
      edits.push(entry.title.split(" ").slice(1).join(" "));
    } else if (SEARCH_TOOLS.has(entry.name)) {
      searches += 1;
    } else if (READ_TOOLS.has(entry.name)) {
      reads.add(entry.title);
    } else if (entry.name === "Bash") {
      commands += 1;
    } else {
      other += 1;
    }
  }
  const parts: string[] = [];
  if (reads.size) parts.push(`Explored ${reads.size} ${reads.size === 1 ? "file" : "files"}`);
  if (searches) parts.push(`${searches} ${searches === 1 ? "search" : "searches"}`);
  if (commands) parts.push(`${commands} ${commands === 1 ? "command" : "commands"}`);
  if (edits.length) {
    const shown = basename(edits[0]!);
    parts.push(`edited ${shown}${edits.length > 1 ? ` +${edits.length - 1}` : ""}`);
  }
  if (other) parts.push(`${other} ${other === 1 ? "tool" : "tools"}`);
  if (!parts.length) return "Worked";
  const [head, ...rest] = parts;
  return rest.length ? `${cap(head!)}, ${rest.join(", ")}` : cap(head!);
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

export interface TranscriptFoldInput {
  /** The chain's turns, oldest first. */
  turns: readonly AgentRun[];
  /** Events per run id; a turn absent here renders as a collapsed row. */
  eventsByRun: Readonly<Record<string, readonly RunEvent[]>>;
  /** Board questions raised by runs of this chain, in board order. */
  questions?: readonly TaskQuestion[];
  /** Worker sessions dispatched by this chain (the node's `workers`). */
  workers?: readonly RunNode[];
  /** Turn ids to render collapsed even when events are loaded (older turns). */
  collapsedTurnIds?: ReadonlySet<string>;
}

export function humanRunFailure(text: string): string {
  const failure = classifyRunFailure(text);
  return failure ? runFailureHint(failure) : text;
}

/**
 * Fold a thread — every turn of the chain, oldest first — into transcript
 * items. Each turn contributes its user row (the prompt; steering notices and
 * wake-ups read as what they are) followed by its folded events.
 */
export function buildTranscriptItems(input: TranscriptFoldInput): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  const questionPool = [...(input.questions ?? [])];
  const workerPool = [...(input.workers ?? [])];

  const takeQuestion = (runId: string, text: string): TaskQuestion | null => {
    let idx = questionPool.findIndex((q) => q.runId === runId && q.text === text);
    if (idx === -1) idx = questionPool.findIndex((q) => q.text === text);
    if (idx === -1) return null;
    return questionPool.splice(idx, 1)[0] ?? null;
  };

  const takeWorker = (parentRunId: string, promptHead: string): RunNode | null => {
    let idx = workerPool.findIndex(
      (w) =>
        w.turns.some((t) => t.parentRunId === parentRunId) &&
        (w.turns[0]!.prompt.split("\n")[0] ?? "") === promptHead,
    );
    if (idx === -1) {
      idx = workerPool.findIndex((w) => w.turns.some((t) => t.parentRunId === parentRunId));
    }
    if (idx === -1) return null;
    return workerPool.splice(idx, 1)[0] ?? null;
  };

  for (const turn of input.turns) {
    if (turn.prompt.trim()) {
      const kickoff = turn.prompt.startsWith(MANAGER_PREAMBLE)
        || MANAGER_OPENING.test(turn.prompt);
      const notice = engineNoticeKind(turn.prompt);
      const promptItem = kickoff
        ? { kind: "kickoff" as const, id: `${turn.id}:prompt`, runId: turn.id, text: turn.prompt }
        : notice === "owner"
          ? {
              kind: "user" as const,
              id: `${turn.id}:prompt`,
              runId: turn.id,
              text: unwrapOwnerMessage(turn.prompt),
              ts: turn.createdAt,
            }
        : notice
          ? { kind: "notice" as const, id: `${turn.id}:prompt`, runId: turn.id, text: turn.prompt }
          : {
              kind: "user" as const,
              id: `${turn.id}:prompt`,
              runId: turn.id,
              text: turn.prompt,
              ts: turn.createdAt,
            };
      items.push(promptItem);
    }

    const events = input.eventsByRun[turn.id];
    if (!events || input.collapsedTurnIds?.has(turn.id)) {
      // Settled turns always have persisted events server-side; render the
      // placeholder and let the view fetch on expand. A queued live turn
      // simply has nothing yet — no placeholder either way once empty.
      if (turn.status !== "queued" && turn.status !== "running") {
        items.push({
          kind: "collapsed-turn",
          id: `${turn.id}:collapsed`,
          runId: turn.id,
          headline: `Turn — ${turn.status}`,
          ts: turn.createdAt,
        });
      }
      continue;
    }
    items.push(...foldTurnEvents(turn, events, takeQuestion, takeWorker));
  }
  return items;
}

function foldTurnEvents(
  turn: AgentRun,
  events: readonly RunEvent[],
  takeQuestion: (runId: string, text: string) => TaskQuestion | null,
  takeWorker: (parentRunId: string, promptHead: string) => RunNode | null,
): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  let work: Extract<TranscriptItem, { kind: "work" }> | null = null;
  const openEntries = new Map<string, WorkEntry>();
  /** Open "pending" permission rows by tool — settled in place by the later allowed/denied event. */
  const openPermissions = new Map<string, Extract<TranscriptItem, { kind: "permission" }>>();
  let assistant: Extract<TranscriptItem, { kind: "assistant" }> | null = null;
  let pendingThinking: string[] = [];

  const closeWork = () => {
    if (!work) return;
    work.title = workTitle(work.entries);
    work.pending = work.entries.some((e) => e.result === null);
    work = null;
    // Results for already-closed work still resolve via openEntries.
  };
  const closeAssistant = () => {
    assistant = null;
  };

  const push = (event: AgentEvent, seq: number) => {
    const id = `${turn.id}:${seq}`;
    switch (event.type) {
      case "text": {
        closeWork();
        if (assistant) {
          assistant.text = `${assistant.text}\n\n${event.text}`;
        } else {
          assistant = {
            kind: "assistant",
            id,
            text: event.text,
            thinking: pendingThinking.length ? pendingThinking.join("\n\n") : null,
          };
          pendingThinking = [];
          items.push(assistant);
        }
        break;
      }
      case "thinking": {
        // Attach to the NEXT assistant row — thinking precedes its prose.
        closeWork();
        pendingThinking.push(event.text);
        break;
      }
      case "tool_use": {
        closeAssistant();
        if (!work) {
          work = {
            kind: "work",
            id,
            title: "Working…",
            entries: [],
            hasError: false,
            pending: true,
          };
          items.push(work);
        }
        const entry: WorkEntry = {
          toolUseId: event.toolUseId,
          name: event.name,
          title: workEntryTitle(event.name, event.input),
          input: pretty(event.input),
          result: null,
          isError: false,
        };
        work.entries.push(entry);
        openEntries.set(event.toolUseId, entry);
        break;
      }
      case "tool_result": {
        const entry = openEntries.get(event.toolUseId);
        if (entry) {
          entry.result = event.content;
          entry.isError = event.isError;
          openEntries.delete(event.toolUseId);
          // Results can land after their work group closed (e.g. a permission
          // prompt closed it mid-flight) — recompute on whichever work item
          // holds the entry, closed or live, so `pending` clears.
          for (const item of items) {
            if (item.kind === "work" && item.entries.includes(entry)) {
              if (event.isError) item.hasError = true;
              item.title = workTitle(item.entries);
              item.pending = item.entries.some((e) => e.result === null);
            }
          }
        }
        break;
      }
      case "question": {
        closeWork();
        closeAssistant();
        items.push({
          kind: "question",
          id,
          runId: turn.id,
          text: event.text,
          options: event.options ?? [],
          recommended: event.recommended ?? null,
          record: takeQuestion(turn.id, event.text),
        });
        break;
      }
      case "dispatch": {
        closeWork();
        closeAssistant();
        items.push({
          kind: "delegation",
          id,
          headline: event.spec.prompt.split("\n")[0] ?? "",
          worker: takeWorker(turn.id, event.spec.prompt.split("\n")[0] ?? ""),
        });
        break;
      }
      case "permission": {
        closeWork();
        closeAssistant();
        if (event.state !== "pending") {
          // The broker emits pending → allowed/denied as two events for the
          // same request (keyed only by tool name); settle the open pending
          // row in place rather than leaving both.
          const open = openPermissions.get(event.tool);
          if (open) {
            open.state = event.state;
            open.detail = event.detail ?? open.detail;
            openPermissions.delete(event.tool);
            break;
          }
        }
        const item: Extract<TranscriptItem, { kind: "permission" }> = {
          kind: "permission",
          id,
          tool: event.tool,
          state: event.state === "pending"
            && !["queued", "running"].includes(turn.status)
            ? "expired"
            : event.state,
          detail: event.detail ?? null,
        };
        items.push(item);
        if (event.state === "pending") openPermissions.set(event.tool, item);
        break;
      }
      case "result": {
        closeWork();
        closeAssistant();
        items.push({
          kind: "turn-end",
          id,
          runId: turn.id,
          ok: event.ok,
          resultText: event.ok ? event.resultText : humanRunFailure(event.resultText),
          costUsd: event.costUsd,
          durationMs: event.durationMs,
        });
        break;
      }
      case "status": {
        // Lifecycle noise; only terminal failures deserve a row (a failed
        // turn without a `result` event — kills, spawn errors).
        if (event.status === "failed" || event.status === "cancelled") {
          closeWork();
          closeAssistant();
          items.push({
            kind: "system",
            id,
            text: event.message && event.message !== event.status
              ? `${event.status} — ${humanRunFailure(event.message)}`
              : event.status,
            tone: "warn",
          });
        }
        break;
      }
      case "stderr":
      case "init":
      case "usage":
      case "unknown":
        break;
    }
  };

  for (const e of events) push(e.event, e.seq);
  closeWork();
  return dedupeTurnEnd(items);
}

/**
 * A turn that both streamed a `result` and settled via `status` can produce a
 * result row followed by a redundant system row with the same text; keep the
 * typed one.
 */
function dedupeTurnEnd(items: TranscriptItem[]): TranscriptItem[] {
  return items.filter((item, i) => {
    if (item.kind !== "system") return true;
    const prev = items[i - 1];
    return !(prev?.kind === "turn-end" && item.text.includes(prev.ok ? "completed" : "failed"));
  });
}

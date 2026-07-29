import fs from "node:fs/promises";
import path from "node:path";
import {
  Emitter,
  GrantsLedgerSchema,
  emptyGrantsLedger,
  nowIso,
  recordDenial,
  setGrantedTools,
  type GrantsLedger,
} from "@crystal/core";

/**
 * The persistence half of the grants ledger (rules in core/grants.ts): one
 * JSON file per workspace under app data, with the same serialized
 * read-modify-write discipline as JsonRecordStore — denial events arrive from
 * concurrent run streams, and two folds racing a naive write would drop one.
 * A corrupt/missing file degrades to an empty ledger (grants are policy, not
 * history — losing them must never take the workspace down).
 */
export class GrantsStore {
  readonly events = new Emitter<{ changed: { ledger: GrantsLedger } }>();
  private queue: Promise<unknown> = Promise.resolve();
  private cached: GrantsLedger | null = null;

  constructor(private readonly dataDir: string) {}

  private file(): string {
    return path.join(this.dataDir, "grants.json");
  }

  async get(): Promise<GrantsLedger> {
    if (this.cached) return this.cached;
    try {
      const raw = JSON.parse(await fs.readFile(this.file(), "utf8"));
      this.cached = GrantsLedgerSchema.parse(raw);
    } catch {
      this.cached = emptyGrantsLedger(nowIso());
    }
    return this.cached;
  }

  /** The granted tool patterns, for spawn-time injection. */
  async allowedTools(): Promise<string[]> {
    return (await this.get()).allowedTools;
  }

  /** Serialized read-modify-write; the change event fires after the write lands. */
  private mutate(fn: (ledger: GrantsLedger) => GrantsLedger): Promise<GrantsLedger> {
    const task = this.queue.then(async () => {
      const next = fn(await this.get());
      await fs.mkdir(this.dataDir, { recursive: true });
      await fs.writeFile(this.file(), JSON.stringify(next, null, 2), "utf8");
      this.cached = next;
      this.events.emit("changed", { ledger: next });
      return next;
    });
    // A rejected mutation must not poison the queue for the next one.
    this.queue = task.catch(() => {});
    return task;
  }

  /** Replace the granted tool list (the IDE's editable half of the ledger). */
  setTools(tools: string[]): Promise<GrantsLedger> {
    return this.mutate((ledger) => setGrantedTools(ledger, tools, nowIso()));
  }

  /** Fold one observed permission denial into the tally. */
  noteDenial(denial: { tool: string; runId: string; workflowId?: string | null }): Promise<GrantsLedger> {
    return this.mutate((ledger) => recordDenial(ledger, { ...denial, at: nowIso() }));
  }
}

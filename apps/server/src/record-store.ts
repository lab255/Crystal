import fs from "node:fs/promises";
import path from "node:path";

/**
 * A directory of JSON records with a serialized read-modify-write.
 *
 * Both orchestration engines keep durable records under app data — workflows
 * per workspace, programs centrally — and both need the same three
 * invariants, which are easy to get subtly wrong twice:
 *
 *  - **A corrupt file is skipped, not fatal.** One unreadable record must not
 *    stop a server from loading the rest.
 *  - **Mutations serialize.** Settlement events race user and agent calls, so
 *    read-modify-write goes through one queue; a rejected mutation must leave
 *    the queue usable rather than poisoning every later one.
 *  - **Disk is the commit point.** A failed write leaves the prior in-memory
 *    record in place, matching what a restart would load.
 *  - **Persist before announcing.** The change event fires only once the
 *    record is on disk, so a listener that re-reads never sees a stale file.
 */
export class JsonRecordStore<T extends { id: string; updatedAt: string }> {
  private records = new Map<string, T>();
  /**
   * The in-flight (or finished) load. Memoizing the *promise* rather than a
   * boolean is what makes concurrent callers wait: a flag flipped before the
   * first `await` lets a second caller through to an empty map, and a
   * settlement that arrives in that window is silently dropped.
   */
  private loading: Promise<void> | null = null;
  /** One queue per record: two programs must not stall each other. */
  private queues = new Map<string, Promise<unknown>>();

  constructor(
    /** Directory holding one `<id>.json` per record. */
    private readonly dir: string,
    /** Validating parser — a record that fails it is treated as corrupt. */
    private readonly parse: (raw: unknown) => T,
    /** Announced after a record is persisted. */
    private readonly onChanged: (record: T) => void,
    /** Timestamp source, stamped on every mutation. */
    private readonly now: () => string,
    /** Test seam for failures after a temporary file has been created. */
    private readonly writeFile: typeof fs.writeFile = fs.writeFile,
  ) {}

  ensureLoaded(): Promise<void> {
    return (this.loading ??= this.load());
  }

  private async load(): Promise<void> {
    const names = await fs.readdir(this.dir).catch(() => [] as string[]);
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      try {
        const record = this.parse(JSON.parse(await fs.readFile(path.join(this.dir, name), "utf8")));
        this.records.set(record.id, record);
      } catch (err) {
        // A bad file must not take the engine down — but it must not vanish
        // silently either: a dropped record's work may still be running.
        console.warn(`[crystal] skipping unreadable record ${name}:`, (err as Error).message);
      }
    }
  }

  /** Every record, newest-first by `createdAt` when the type has one. */
  async list(): Promise<T[]> {
    await this.ensureLoaded();
    return [...this.records.values()].sort((a, b) =>
      String((b as { createdAt?: string }).createdAt ?? "").localeCompare(
        String((a as { createdAt?: string }).createdAt ?? ""),
      ),
    );
  }

  async get(id: string): Promise<T | null> {
    await this.ensureLoaded();
    const record = this.records.get(id);
    return record ? { ...record } : null;
  }

  /** The in-memory record without loading or copying — for hot lookups. */
  peek(id: string): T | undefined {
    return this.records.get(id);
  }

  /** Every in-memory record without copying — for cross-record checks. */
  all(): T[] {
    return [...this.records.values()];
  }

  /** Insert a record that did not exist yet (creation, not mutation). */
  put(record: T): Promise<void> {
    return this.serialize(record.id, async () => {
      await this.ensureLoaded();
      // Validate before it lands: an invalid record written now is a record
      // that fails to parse on the next boot and vanishes entirely.
      const validated = this.parse(record);
      await this.persist(validated);
      this.records.set(validated.id, validated);
      this.onChanged({ ...validated });
    });
  }

  /**
   * Forget a record. Serialized like every other write — otherwise a mutation
   * suspended mid-flight resurrects the record (in memory *and* on disk) when
   * it resumes and writes its result.
   */
  remove(id: string): Promise<void> {
    return this.serialize(id, async () => {
      await this.ensureLoaded();
      await fs.rm(path.join(this.dir, `${id}.json`), { force: true });
      this.records.delete(id);
    });
  }

  /**
   * Serialize one read-modify-write. `fn` returns the next record plus a
   * result for the caller; the record is stamped, stored, persisted, and
   * announced before the promise resolves.
   */
  mutate<R>(
    id: string,
    fn: (record: T) => { record: T; result: R } | Promise<{ record: T; result: R }>,
  ): Promise<R> {
    return this.serialize(id, async () => {
      await this.ensureLoaded();
      const current = this.records.get(id);
      if (!current) throw new Error(`Unknown record: ${id}`);
      const { record, result } = await fn(current);
      // Returning the record you were handed means "nothing changed" — a
      // refused transition must not bump `updatedAt`, rewrite the file and
      // broadcast a change that did not happen.
      if (record === current) return result;
      // Removed while this mutation was in flight: do not resurrect it.
      if (!this.records.has(id)) return result;
      record.updatedAt = this.now();
      const validated = this.parse(record);
      await this.persist(validated);
      this.records.set(validated.id, validated);
      this.onChanged({ ...validated });
      return result;
    });
  }

  /**
   * Run `fn` after every earlier write to the same record. The queue survives
   * failures — a rejected step must not poison every later one — while the
   * caller still sees the rejection.
   */
  private serialize<R>(id: string, fn: () => Promise<R>): Promise<R> {
    const step = (this.queues.get(id) ?? Promise.resolve()).then(fn);
    this.queues.set(
      id,
      step.catch(() => {}),
    );
    return step;
  }

  private async persist(record: T): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    const target = path.join(this.dir, `${record.id}.json`);
    const temp = path.join(
      this.dir,
      `.${record.id}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
    );
    let landed = false;
    try {
      await this.writeFile(temp, JSON.stringify(record, null, 2), "utf8");
      await fs.rename(temp, target);
      landed = true;
    } finally {
      if (!landed) await fs.rm(temp, { force: true }).catch(() => {});
    }
  }
}

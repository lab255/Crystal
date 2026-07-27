/**
 * A per-key queue of things waiting to be said to a session that cannot take
 * them right now. Three engines carry one (worker notices per manager chain,
 * workflow user messages, hub program notices) and all share the same
 * delivery contract, which is subtler than it looks:
 *
 * - delivery is *attempted*, and a failed attempt must keep everything
 *   queued — the next settlement retries;
 * - a successful attempt must drop exactly the items the attempt carried.
 *   Items pushed while the attempt was in flight (a worker settling during
 *   the manager's resume) survive for the next flush.
 *
 * The policies stay at the call sites — what composes the prompt, which
 * delivery ladder to try, when a queue is abandoned outright (clear).
 */
export class PendingQueue<T> {
  private queues = new Map<string, T[]>();

  push(key: string, item: T): void {
    const queue = this.queues.get(key);
    if (queue) queue.push(item);
    else this.queues.set(key, [item]);
  }

  size(key: string): number {
    return this.queues.get(key)?.length ?? 0;
  }

  /** Abandon everything queued for `key` (e.g. a cancelled manager stays dead). */
  clear(key: string): void {
    this.queues.delete(key);
  }

  /**
   * Attempt to deliver everything currently queued for `key`. `deliver`
   * receives a snapshot; a truthy resolution means the snapshot landed and is
   * dropped (later pushes survive), falsy keeps the queue untouched. Returns
   * whether delivery happened. Rejections propagate with the queue intact.
   */
  async drain(key: string, deliver: (items: readonly T[]) => Promise<unknown>): Promise<boolean> {
    const queue = this.queues.get(key);
    if (!queue?.length) return false;
    const snapshot = [...queue];
    if (!(await deliver(snapshot))) return false;
    const rest = (this.queues.get(key) ?? []).slice(snapshot.length);
    if (rest.length) this.queues.set(key, rest);
    else this.queues.delete(key);
    return true;
  }
}

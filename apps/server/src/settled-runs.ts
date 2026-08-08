import type { AgentRun } from "@crystal/core";

/**
 * Settle-once bookkeeping, shared by everything that hangs work off a run
 * reaching a terminal state.
 *
 * Terminal `runChanged` events can be observed more than once across lifecycle
 * adapters, so every listener needs the same two rules: react exactly once per
 * run, and don't remember run ids forever (a long-lived server would leak one
 * string per run for its whole life). Three listeners grew their own copy of
 * this before it was extracted:
 * the workspace runtime (task billing), the workflow engine (budget + message
 * flush) and the hub engine (program-manager wake-ups).
 */
export class SettledRuns {
  private seen = new Set<string>();

  constructor(private readonly max = 500) {}

  /** True when the run has reached a terminal state — the trigger condition. */
  static isTerminal(run: Pick<AgentRun, "status">): boolean {
    return run.status === "completed" || run.status === "failed" || run.status === "cancelled";
  }

  /**
   * True the *first* time a settled run is offered, false for every repeat
   * (and for a run that is still live). Prunes oldest-first past `max`.
   */
  claim(run: Pick<AgentRun, "id" | "status">): boolean {
    if (!SettledRuns.isTerminal(run) || this.seen.has(run.id)) return false;
    this.seen.add(run.id);
    while (this.seen.size > this.max) {
      const oldest = this.seen.values().next().value;
      if (oldest === undefined) break;
      this.seen.delete(oldest);
    }
    return true;
  }
}

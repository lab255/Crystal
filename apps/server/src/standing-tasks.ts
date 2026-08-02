import fs from "node:fs/promises";
import path from "node:path";
import {
  Emitter,
  StandingTasksFileSchema,
  buildStandingFirePrompt,
  nextFireAt,
  nowIso,
  standingTag,
  type StandingTask,
  type StandingTaskInfo,
} from "@crystal/core";
import type { z } from "zod";
import type { AgentManager } from "./agent-manager.js";
import type { WorkspaceStore } from "./workspace-store.js";

/** Sweep cadence — schedules are minute-grained, so once a minute is plenty. */
const SWEEP_INTERVAL_MS = 60_000;

/**
 * Fires standing tasks (see core standing-task.ts) on their schedules.
 * Definitions are repo-durable; `lastFiredAt` persists to app-data so a
 * restart neither re-fires a fresh task nor forgets a missed daily slot
 * (nextFireAt treats a passed slot as due — the boot sweep catches it up).
 * One live fire per task: a fire whose run is still working suppresses the
 * next one rather than stacking sessions.
 */
export class StandingTaskEngine {
  readonly events = new Emitter<{ changed: Record<string, never> }>();

  private defs = new Map<string, StandingTask>();
  /** When each task last ACTUALLY fired — the display value, drives the schedule. */
  private lastFired = new Map<string, string>();
  /**
   * Trust-gate floor: a task loaded from the repo file that has never fired
   * here won't fire before this instant, so merely opening a repo can't
   * auto-run its (code-exec-capable) agent. Kept distinct from `lastFired` so
   * the UI never shows a gate-seed as a real fire.
   */
  private notBefore = new Map<string, string>();
  private loaded = false;
  private timer: NodeJS.Timeout | null = null;
  private sweeping = false;
  /**
   * Tasks with a `fire()` in flight — set synchronously before the
   * liveRunId/persist awaits, so two concurrent fires (double "run now", or a
   * "run now" landing while the sweeper fires the same task) can't both pass
   * the not-yet-registered liveRunId check and spawn two sessions.
   */
  private firing = new Set<string>();

  constructor(
    private readonly dataDir: string,
    private readonly agents: AgentManager,
    private readonly store: WorkspaceStore,
  ) {}

  private stateFile(): string {
    return path.join(this.dataDir, "standing-state.json");
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    const file = await this.store.loadStandingTasks();
    for (const task of file.tasks) this.defs.set(task.id, task);
    try {
      const raw = JSON.parse(await fs.readFile(this.stateFile(), "utf8")) as {
        lastFired?: Record<string, string>;
        notBefore?: Record<string, string>;
      };
      for (const [id, at] of Object.entries(raw.lastFired ?? {})) {
        if (typeof at === "string") this.lastFired.set(id, at);
      }
      for (const [id, at] of Object.entries(raw.notBefore ?? {})) {
        if (typeof at === "string") this.notBefore.set(id, at);
      }
    } catch {
      /* first run */
    }
    await this.sealFloors();
  }

  /**
   * Trust gate: give every never-fired task a "don't fire before now" floor.
   * A task therefore never fires retroactively — its first fire is always a
   * genuine future scheduled slot — so merely OPENING a repo whose
   * `.crystal/standing-tasks.json` defines a due task can't auto-spawn its
   * (code-exec-capable) agent with no user action. Only tasks with a real fire
   * history catch up on missed slots after a restart.
   */
  private async sealFloors(): Promise<void> {
    const floor = nowIso();
    let sealed = false;
    for (const id of this.defs.keys()) {
      if (!this.lastFired.has(id) && !this.notBefore.has(id)) {
        this.notBefore.set(id, floor);
        sealed = true;
      }
    }
    if (sealed) await this.persistState();
  }

  /** The effective schedule anchor for a task: its last real fire, floored by the trust gate. */
  private scheduleAnchor(id: string): string | null {
    const last = this.lastFired.get(id) ?? null;
    const floor = this.notBefore.get(id) ?? null;
    if (last && floor) return last > floor ? last : floor;
    return last ?? floor;
  }

  /** Start the sweeper (workspace open). The first sweep runs immediately. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS);
    void this.sweep();
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async list(): Promise<StandingTaskInfo[]> {
    await this.ensureLoaded();
    const infos: StandingTaskInfo[] = [];
    for (const def of this.defs.values()) {
      infos.push({
        def,
        // Only REAL fires are surfaced — a trust-gate floor is not a fire.
        lastFiredAt: this.lastFired.get(def.id) ?? null,
        nextFireAt: def.enabled
          ? nextFireAt(def.schedule, this.scheduleAnchor(def.id)).toISOString()
          : null,
        liveRunId: await this.liveRunId(def.id),
      });
    }
    return infos;
  }

  /** Replace the definitions (validated once, in the store) and persist. */
  async saveDefs(tasks: z.input<typeof StandingTasksFileSchema>): Promise<StandingTaskInfo[]> {
    await this.ensureLoaded();
    const file = await this.store.saveStandingTasks(tasks);
    this.defs = new Map(file.tasks.map((t) => [t.id, t]));
    for (const id of [...this.lastFired.keys()]) {
      if (!this.defs.has(id)) this.lastFired.delete(id);
    }
    for (const id of [...this.notBefore.keys()]) {
      if (!this.defs.has(id)) this.notBefore.delete(id);
    }
    // A newly-created task gets its floor too — first fire is a future slot,
    // never an immediate retroactive one.
    await this.sealFloors();
    this.events.emit("changed", {});
    return this.list();
  }

  /** Fire a task now (the UI's "run now"), schedule notwithstanding. */
  async fireNow(taskId: string): Promise<{ runId: string | null; reason: string | null }> {
    await this.ensureLoaded();
    const def = this.defs.get(taskId);
    if (!def) throw new Error(`Unknown standing task: ${taskId}`);
    return this.fire(def);
  }

  private async liveRunId(taskId: string): Promise<string | null> {
    const tag = standingTag(taskId);
    for (const run of await this.agents.list()) {
      if ((run.status === "running" || run.status === "queued") && run.tags.includes(tag)) {
        return run.id;
      }
    }
    return null;
  }

  private async sweep(): Promise<void> {
    if (this.sweeping) return; // a slow fire must not stack sweeps
    this.sweeping = true;
    try {
      await this.ensureLoaded();
      const now = new Date();
      for (const def of this.defs.values()) {
        if (!def.enabled) continue;
        const due = nextFireAt(def.schedule, this.scheduleAnchor(def.id), now);
        if (due.getTime() > now.getTime()) continue;
        await this.fire(def);
      }
    } catch (err) {
      console.warn("[crystal] standing-task sweep failed:", (err as Error).message);
    } finally {
      this.sweeping = false;
    }
  }

  private async fire(def: StandingTask): Promise<{ runId: string | null; reason: string | null }> {
    // Synchronous in-flight claim, BEFORE any await: liveRunId can't yet see a
    // run whose agents.start hasn't registered it, so two concurrent fires
    // (double "run now", or "run now" racing the sweeper) would otherwise both
    // pass the liveRunId check and spawn two sessions for one task.
    if (this.firing.has(def.id)) {
      return { runId: null, reason: "The previous fire is still running." };
    }
    this.firing.add(def.id);
    try {
      if (await this.liveRunId(def.id)) {
        return { runId: null, reason: "The previous fire is still running." };
      }
      // Stamp BEFORE spawning: a fire that crashes the spawn must not retry
      // every sweep tick — the next slot comes from the schedule.
      this.lastFired.set(def.id, nowIso());
      await this.persistState();
      const run = await this.agents.start({
        prompt: buildStandingFirePrompt(def),
        cwd: def.cwd,
        isolation: def.isolation,
        purpose: "manage",
        tags: [standingTag(def.id)],
      });
      this.events.emit("changed", {});
      return { runId: run.id, reason: null };
    } catch (err) {
      this.events.emit("changed", {});
      return { runId: null, reason: (err as Error).message };
    } finally {
      this.firing.delete(def.id);
    }
  }

  private async persistState(): Promise<void> {
    try {
      await fs.mkdir(this.dataDir, { recursive: true });
      await fs.writeFile(
        this.stateFile(),
        JSON.stringify(
          {
            lastFired: Object.fromEntries(this.lastFired),
            notBefore: Object.fromEntries(this.notBefore),
          },
          null,
          2,
        ),
        "utf8",
      );
    } catch (err) {
      console.warn("[crystal] could not persist standing-task state:", (err as Error).message);
    }
  }
}

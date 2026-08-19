import { useCallback, useEffect, useState } from "react";
import { CalendarClock, Play, Plus, Trash2 } from "lucide-react";
import {
  createStandingTask,
  formatRecapAge,
  formatSchedule,
  type StandingSchedule,
  type StandingTaskInfo,
} from "@crystal/core";
import { useCrystal, useNavUpdate } from "@crystal/client";
import { Badge, Button, Input, Spinner, Tooltip, cn } from "@crystal/ui";

/**
 * Standing tasks — scheduled agent work (see core standing-task.ts). Each
 * fire is a fresh session tagged `standing:<id>`, so the fire history is the
 * runs list filtered by that tag.
 */
export function StandingTasksSection() {
  const { client } = useCrystal();
  const updateNav = useNavUpdate();
  const [tasks, setTasks] = useState<StandingTaskInfo[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const { tasks: list } = await client.request("standing.list", {});
    setTasks(list);
  }, [client]);

  useEffect(() => {
    void refresh().catch(() => setTasks([]));
    return client.events.on("standing.changed", ({ ws }) => {
      if (client.scope && ws !== client.scope) return;
      void refresh().catch(() => {});
    });
  }, [client, refresh]);

  async function save(defs: StandingTaskInfo["def"][]): Promise<void> {
    const { tasks: list } = await client.request("standing.save", { tasks: { tasks: defs } });
    setTasks(list);
  }

  async function fireNow(taskId: string): Promise<void> {
    setNotice(null);
    try {
      const result = await client.request("standing.fire", { taskId });
      if (result.runId) {
        updateNav({ mode: "threads", threads: { thread: result.runId, compose: null } });
      } else {
        setNotice(result.reason ?? "Fire suppressed.");
      }
    } catch (err) {
      setNotice((err as Error).message);
    }
  }

  const defs = (tasks ?? []).map((t) => t.def);

  return (
    <section className="rounded-xl border border-edge bg-surface-1 p-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="flex items-start gap-2.5">
          <span className="mt-0.5 text-ink-faint">
            <CalendarClock className="h-4 w-4" />
          </span>
          <div>
            <h2 className="text-[13px] font-semibold text-ink">Standing tasks</h2>
            <p className="text-[11px] text-ink-faint">
              Scheduled agent work — each fire is a fresh session; missed slots catch up when the
              server is back.
            </p>
          </div>
        </div>
        <Button variant="ghost" size="xs" onClick={() => setAdding((a) => !a)}>
          <Plus className="h-3.5 w-3.5" /> Add
        </Button>
      </div>

      {adding ? (
        <AddStandingTaskForm
          onAdd={async (def) => {
            await save([...defs, def]);
            setAdding(false);
          }}
          onCancel={() => setAdding(false)}
        />
      ) : null}

      {tasks === null ? (
        <Spinner className="h-3.5 w-3.5" />
      ) : tasks.length === 0 && !adding ? (
        <p className="text-[11px] text-ink-faint">
          No standing tasks yet — try “nightly at 03:00: update dependencies and run the suite”.
        </p>
      ) : (
        <div className="flex flex-col gap-1">
          {tasks.map((task) => (
            <div key={task.def.id} className="rounded-lg border border-edge bg-surface-2 px-2.5 py-1.5">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  title={task.def.enabled ? "Disable" : "Enable"}
                  onClick={() =>
                    void save(
                      defs.map((d) => (d.id === task.def.id ? { ...d, enabled: !d.enabled } : d)),
                    )
                  }
                  className={cn(
                    "rounded-full border px-1.5 text-[9px] uppercase tracking-wide",
                    task.def.enabled ? "border-ok/40 text-ok" : "border-edge text-ink-faint",
                  )}
                >
                  {task.def.enabled ? "on" : "off"}
                </button>
                <span className="shrink-0 text-[12px] font-medium text-ink">{task.def.name}</span>
                <Badge tone="violet">{formatSchedule(task.def.schedule)}</Badge>
                {task.def.isolation === "worktree" ? <Badge tone="cyan">worktree</Badge> : null}
                <span className="min-w-0 flex-1 truncate text-[11px] text-ink-faint">
                  {task.def.instructions}
                </span>
                {task.liveRunId ? (
                  <button
                    type="button"
                    onClick={() =>
                      updateNav({
                        mode: "threads",
                        threads: { thread: task.liveRunId!, compose: null },
                      })
                    }
                    className="shrink-0 rounded-full bg-info/15 px-2 text-[10px] text-info hover:bg-info/25"
                  >
                    firing now
                  </button>
                ) : task.lastFiredAt ? (
                  <span className="shrink-0 text-[10px] text-ink-faint">
                    fired {formatRecapAge(task.lastFiredAt)}
                  </span>
                ) : null}
                <Tooltip content="Fire now (fresh session)">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Fire ${task.def.name} now`}
                    onClick={() => void fireNow(task.def.id)}
                  >
                    <Play className="h-3 w-3 text-ok" />
                  </Button>
                </Tooltip>
                <Tooltip content="Delete standing task">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Delete ${task.def.name}`}
                    onClick={() => void save(defs.filter((d) => d.id !== task.def.id))}
                  >
                    <Trash2 className="h-3 w-3 text-danger" />
                  </Button>
                </Tooltip>
              </div>
            </div>
          ))}
        </div>
      )}
      {notice ? <p className="mt-2 text-[11px] text-warn">{notice}</p> : null}
    </section>
  );
}

function AddStandingTaskForm({
  onAdd,
  onCancel,
}: {
  onAdd: (def: ReturnType<typeof createStandingTask>) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [instructions, setInstructions] = useState("");
  const [mode, setMode] = useState<"every" | "daily">("daily");
  const [every, setEvery] = useState("60");
  const [at, setAt] = useState("03:00");
  const [worktree, setWorktree] = useState(true);
  const [saving, setSaving] = useState(false);

  const schedule: StandingSchedule | null =
    mode === "every"
      ? /^\d+$/.test(every.trim()) && Number(every) >= 5
        ? { kind: "every", minutes: Number(every) }
        : null
      : /^([01]?\d|2[0-3]):[0-5]\d$/.test(at.trim())
        ? {
            kind: "daily",
            hour: Number(at.split(":")[0]),
            minute: Number(at.split(":")[1]),
          }
        : null;
  const valid = name.trim() && instructions.trim() && schedule != null;

  return (
    <form
      className="mb-3 space-y-2 rounded-lg border border-edge bg-surface-2 p-2.5"
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid || !schedule) return;
        setSaving(true);
        void onAdd(
          createStandingTask({
            name: name.trim(),
            instructions: instructions.trim(),
            schedule,
            isolation: worktree ? "worktree" : "none",
          }),
        ).finally(() => setSaving(false));
      }}
    >
      <div className="grid grid-cols-[1fr_2fr] gap-2">
        <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Name (e.g. nightly deps)" aria-label="Standing task name" />
        <Input value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder="What each fire should do" aria-label="Instructions" />
      </div>
      <div className="flex items-center gap-2 text-[11px] text-ink-muted">
        <select
          className="h-7 rounded-lg border border-edge bg-surface-1 px-1.5 text-[11px] text-ink"
          value={mode}
          onChange={(e) => setMode(e.target.value as "every" | "daily")}
          aria-label="Schedule kind"
        >
          <option value="daily">daily at</option>
          <option value="every">every N minutes</option>
        </select>
        {mode === "daily" ? (
          <Input value={at} onChange={(e) => setAt(e.target.value)} className="w-20" aria-label="Time (HH:MM)" placeholder="03:00" />
        ) : (
          <Input value={every} onChange={(e) => setEvery(e.target.value)} className="w-20" aria-label="Minutes" placeholder="60" />
        )}
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={worktree}
            onChange={(e) => setWorktree(e.target.checked)}
          />
          isolate in a worktree
        </label>
        <span className="flex-1" />
        <Button type="button" variant="ghost" size="xs" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" size="xs" disabled={!valid || saving}>
          {saving ? <Spinner className="h-3 w-3" /> : <Plus className="h-3 w-3" />} Add task
        </Button>
      </div>
    </form>
  );
}

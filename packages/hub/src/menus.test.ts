import { describe, expect, it } from "vitest";
import { addDelivery, createProgram, patchDelivery, type Program } from "@crystal/core";
import type { NavPatch } from "@crystal/client";
import { deliveryHint, deliveryMenuEntries, hubDeepLink, programMenuEntries } from "./menus.js";

function ctx() {
  const patches: NavPatch[] = [];
  const focused: string[] = [];
  const copied: string[] = [];
  return {
    nav: (p: NavPatch) => void patches.push(p),
    setActiveWorkspace: (ws: string) => void focused.push(ws),
    copy: (t: string) => void copied.push(t),
    patches,
    focused,
    copied,
  };
}

const labels = (entries: ReturnType<typeof programMenuEntries>): string[] =>
  entries.map((e) => (e.type === "separator" ? "—" : e.label));

/** A program with a dispatched auth delivery and a blocked web delivery. */
function fixture(): { program: Program; authId: string; webId: string } {
  const base = createProgram({ name: "SSO", goal: "g" });
  const first = addDelivery(base, { projectRoot: "/repos/auth-service", brief: "Issue tokens." });
  const second = addDelivery(first.program, {
    projectRoot: "/repos/web-console",
    brief: "Log in.",
    dependsOn: [first.delivery.id],
  });
  const program = patchDelivery(second.program, first.delivery.id, {
    status: "running",
    ws: "ws-auth",
    workflowId: "wf_1",
  });
  return { program, authId: first.delivery.id, webId: second.delivery.id };
}

describe("deliveryMenuEntries", () => {
  it("crosses into the owning project — switching workspace first", () => {
    const { program, authId } = fixture();
    const c = ctx();
    const entries = deliveryMenuEntries(program, program.deliveries[0]!, c);
    expect(labels(entries)).toEqual([
      "auth-service · running",
      "—",
      "Open workflow in Orchestrate",
      "Open the project board",
      "Show the project's agent runs",
      "Open the project's architecture",
      "—",
      "Copy link to this delivery",
      "Copy project path",
    ]);

    const open = entries.find((e) => e.type === "item" && e.label === "Open workflow in Orchestrate");
    if (open?.type !== "item") throw new Error("missing entry");
    open.onSelect();
    // The target lives in another workspace: focus it, then navigate.
    expect(c.focused).toEqual(["ws-auth"]);
    expect(c.patches).toEqual([
      {
        ws: "ws-auth",
        mode: "orchestrate",
        orchestrate: { tab: "workflows", workflow: "wf_1" },
      },
    ]);
    expect(authId).toBeDefined();
  });

  it("omits project jumps for a delivery that has never been dispatched", () => {
    const { program } = fixture();
    const entries = deliveryMenuEntries(program, program.deliveries[1]!, ctx());
    expect(labels(entries)).toEqual([
      "web-console · pending",
      "—",
      "Copy link to this delivery",
      "Copy project path",
    ]);
  });

  it("disables dispatch with the reason it is blocked", () => {
    const { program } = fixture();
    const entries = deliveryMenuEntries(program, program.deliveries[1]!, ctx(), {
      dispatch: () => {},
    });
    const dispatch = entries.find((e) => e.type === "item" && e.label === "Dispatch to this project");
    if (dispatch?.type !== "item") throw new Error("missing entry");
    expect(dispatch.disabled).toBe(true);
    expect(dispatch.hint).toMatch(/Blocked by/);
  });

  it("offers messaging only while a dispatched delivery is still live", () => {
    const { program, authId } = fixture();
    const actions = { message: () => {} };
    expect(
      labels(deliveryMenuEntries(program, program.deliveries[0]!, ctx(), actions)),
    ).toContain("Message its orchestrator");

    const done = patchDelivery(program, authId, { status: "completed" });
    expect(labels(deliveryMenuEntries(done, done.deliveries[0]!, ctx(), actions))).not.toContain(
      "Message its orchestrator",
    );
  });

  it("refuses to remove a delivery something else depends on", () => {
    const { program } = fixture();
    const base = createProgram({ name: "P", goal: "g" });
    const only = addDelivery(base, { projectRoot: "/repos/a", brief: "b" });
    const removable = deliveryMenuEntries(only.program, only.delivery, ctx(), { remove: () => {} }).find(
      (e) => e.type === "item" && e.label === "Remove delivery",
    );
    if (removable?.type !== "item") throw new Error("missing entry");
    expect(removable.disabled).toBe(false);

    // The auth delivery has a dependent — and is dispatched, so no entry at all.
    expect(
      labels(deliveryMenuEntries(program, program.deliveries[0]!, ctx(), { remove: () => {} })),
    ).not.toContain("Remove delivery");
  });

  it("offers retry only once a delivery has finished", () => {
    const { program, authId } = fixture();
    const actions = { retry: () => {} };
    // Running: nothing to retry.
    expect(labels(deliveryMenuEntries(program, program.deliveries[0]!, ctx(), actions))).not.toContain(
      "Retry delivery",
    );
    const failed = patchDelivery(program, authId, { status: "failed" });
    expect(labels(deliveryMenuEntries(failed, failed.deliveries[0]!, ctx(), actions))).toContain(
      "Retry delivery",
    );
    // A completed one is not offered: re-running it would drop the summary its
    // dependents were dispatched with (and the server refuses it).
    const done = patchDelivery(program, authId, { status: "completed" });
    expect(labels(deliveryMenuEntries(done, done.deliveries[0]!, ctx(), actions))).not.toContain(
      "Retry delivery",
    );
  });

  it("copies a deep link that reopens exactly this delivery", () => {
    const { program, authId } = fixture();
    const c = ctx();
    const entries = deliveryMenuEntries(program, program.deliveries[0]!, c);
    const copy = entries.find((e) => e.type === "item" && e.label === "Copy link to this delivery");
    if (copy?.type !== "item") throw new Error("missing entry");
    copy.onSelect();
    expect(c.copied[0]).toBe(`#/hub/programs?program=${program.id}&delivery=${authId}`);
    expect(hubDeepLink(program.id)).toBe(`#/hub/programs?program=${program.id}`);
  });
});

describe("programMenuEntries", () => {
  it("hints how much is ready and hides lifecycle actions once terminal", () => {
    const { program } = fixture();
    const actions = {
      dispatch: () => {},
      setPaused: () => {},
      cancel: () => {},
      startManager: () => {},
    };
    const live = programMenuEntries(program, ctx(), actions);
    expect(labels(live)).toEqual([
      "SSO",
      "Dispatch ready deliveries",
      "Start a program manager",
      "Pause program",
      "Cancel program",
      "—",
      "Copy link to this program",
      "Copy program id",
    ]);
    const dispatch = live.find((e) => e.type === "item" && e.label === "Dispatch ready deliveries");
    if (dispatch?.type !== "item") throw new Error("missing entry");
    // The web delivery is blocked and auth is already running — nothing ready.
    expect(dispatch.disabled).toBe(true);
    expect(dispatch.hint).toBe("nothing ready");

    const done: Program = { ...program, status: "completed" };
    expect(labels(programMenuEntries(done, ctx(), actions))).toEqual([
      "SSO",
      "Dispatch ready deliveries",
      "Start a program manager",
      "—",
      "Copy link to this program",
      "Copy program id",
    ]);
  });

  it("offers a manager only when the program has none", () => {
    const { program } = fixture();
    const withManager: Program = { ...program, managerRunId: "run_1" };
    expect(
      labels(programMenuEntries(withManager, ctx(), { startManager: () => {} })),
    ).not.toContain("Start a program manager");
  });
});

describe("deliveryHint", () => {
  it("names the projects a pending delivery is waiting on, and nothing otherwise", () => {
    const { program } = fixture();
    expect(deliveryHint(program, program.deliveries[1]!)).toBe("waiting on auth-service");
    expect(deliveryHint(program, program.deliveries[0]!)).toBeNull();
  });
});

describe("close and compact entries", () => {
  it("offers both on a live dispatched delivery, close alone on a pending one", () => {
    const { program } = fixture();
    const actions = { close: () => {}, compact: () => {} };
    const live = labels(deliveryMenuEntries(program, program.deliveries[0]!, ctx(), actions));
    expect(live).toContain("Mark settled externally…");
    expect(live).toContain("Compact its orchestrator");

    // Pending: nothing to compact (no workflow yet), but its work may already
    // have been absorbed elsewhere — closing must stay possible.
    const pending = labels(deliveryMenuEntries(program, program.deliveries[1]!, ctx(), actions));
    expect(pending).toContain("Mark settled externally…");
    expect(pending).not.toContain("Compact its orchestrator");

    // Terminal: settled is settled.
    const done = patchDelivery(program, program.deliveries[0]!.id, { status: "completed" });
    const settled = labels(deliveryMenuEntries(done, done.deliveries[0]!, ctx(), actions));
    expect(settled).not.toContain("Mark settled externally…");
    expect(settled).not.toContain("Compact its orchestrator");
  });
});

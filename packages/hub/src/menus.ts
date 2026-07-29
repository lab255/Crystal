import {
  Archive,
  Ban,
  Boxes,
  CheckCircle2,
  ClipboardCopy,
  Link2,
  ListTodo,
  Pause,
  Play,
  Rocket,
  RotateCcw,
  Send,
  Trash2,
  Network,
  Bot,
} from "lucide-react";
import {
  deliveryBlockers,
  deliveryById,
  deliveryReadiness,
  formatDeepLink,
  isDeliveryTerminal,
  isProgramLive,
  type Program,
  type ProgramDelivery,
} from "@crystal/core";
import type { NavPatch } from "@crystal/client";
import type { MenuEntry } from "@crystal/ui";

/**
 * Context-menu builders for the Hub — pure, so the cross-boundary navigation
 * they encode (a delivery → that project's workflow, board and runs) is
 * unit-testable without React. Mirrors `symbolMenuEntries` in @crystal/client:
 * the view composes its own entries on top of what these return.
 *
 * Every jump out of the Hub is *cross-project*: the target lives in another
 * workspace, so it switches the active workspace first and only then navigates
 * — the same rule the code map follows at its "all workspaces" level.
 */
export interface HubMenuContext {
  nav: (patch: NavPatch) => void;
  /** Focus a workspace before navigating into a workspace-scoped mode. */
  setActiveWorkspace: (ws: string) => void;
  copy: (text: string) => void;
}

/** Actions a view wires into the menu; omit one to hide its entries. */
export interface DeliveryMenuActions {
  dispatch?: (deliveryId: string) => void;
  message?: (deliveryId: string) => void;
  remove?: (deliveryId: string) => void;
  retry?: (deliveryId: string) => void;
  /** Settle it externally (outcome + note); the view collects the note. */
  close?: (deliveryId: string) => void;
  /** Checkpoint its orchestrator into a fresh session. */
  compact?: (deliveryId: string) => void;
  /**
   * The rest of the portfolio. The one-orchestrator-per-project rule spans
   * programs, so without this the menu offers a dispatch the server refuses.
   */
  others?: readonly Program[];
}

export interface ProgramMenuActions {
  /** The rest of the portfolio (see {@link DeliveryMenuActions.others}). */
  others?: readonly Program[];
  dispatch?: () => void;
  setPaused?: (paused: boolean) => void;
  cancel?: () => void;
  startManager?: () => void;
  /** Forget a finished program (offered only once it is terminal). */
  remove?: () => void;
}

/** Absolute deep link to one program (and optionally a delivery) in the Hub. */
export function hubDeepLink(programId: string, deliveryId?: string | null): string {
  return formatDeepLink({
    mode: "hub",
    hub: { view: "programs", program: programId, ...(deliveryId ? { delivery: deliveryId } : {}) },
  });
}

/**
 * Cross into a project: its board, its runs, its architecture. Shared by the
 * delivery menu and the projects grid so the labels, the icons and — the part
 * that matters — the "focus the workspace *before* navigating" rule have one
 * definition.
 */
export function projectMenuEntries(ws: string, ctx: HubMenuContext): MenuEntry[] {
  const go = (patch: NavPatch) => {
    ctx.setActiveWorkspace(ws);
    ctx.nav({ ws, ...patch });
  };
  return [
    {
      type: "item",
      label: "Open the project board",
      icon: ListTodo,
      onSelect: () => go({ mode: "orchestrate", orchestrate: { tab: "board" } }),
    },
    {
      type: "item",
      label: "Show the project's agent runs",
      icon: Bot,
      onSelect: () => go({ mode: "orchestrate", orchestrate: { tab: "runs" } }),
    },
    {
      type: "item",
      label: "Open the project's architecture",
      icon: Boxes,
      onSelect: () => go({ mode: "architect", architect: { view: "architecture" } }),
    },
  ];
}

/**
 * The standard block for one delivery: act on it, then cross into the project
 * that owns it. The project entries need a workspace, which a delivery only
 * has once dispatched — before that they are omitted rather than shown broken.
 */
export function deliveryMenuEntries(
  program: Program,
  delivery: ProgramDelivery,
  ctx: HubMenuContext,
  actions: DeliveryMenuActions = {},
): MenuEntry[] {
  const entries: MenuEntry[] = [
    { type: "heading", label: `${delivery.projectName} · ${delivery.status}` },
  ];
  const readiness = deliveryReadiness(program, delivery, actions.others ?? []);
  if (actions.dispatch) {
    entries.push({
      type: "item",
      label: "Dispatch to this project",
      icon: Rocket,
      disabled: !readiness.ready,
      hint: readiness.ready ? undefined : readiness.reason,
      onSelect: () => actions.dispatch!(delivery.id),
    });
  }
  if (actions.message && delivery.workflowId && !isDeliveryTerminal(delivery.status)) {
    entries.push({
      type: "item",
      label: "Message its orchestrator",
      icon: Send,
      onSelect: () => actions.message!(delivery.id),
    });
  }
  if (actions.compact && delivery.workflowId && !isDeliveryTerminal(delivery.status)) {
    entries.push({
      type: "item",
      label: "Compact its orchestrator",
      icon: Archive,
      hint: "fresh session, lower resume cost",
      onSelect: () => actions.compact!(delivery.id),
    });
  }
  // The "settled externally" verb: work that finished (or died) outside the
  // workflow. Offered for anything not yet terminal — including pending, whose
  // work may have been absorbed before it ever dispatched.
  if (actions.close && !isDeliveryTerminal(delivery.status)) {
    entries.push({
      type: "item",
      label: "Mark settled externally…",
      icon: CheckCircle2,
      hint: "records outcome + note, stops its workflow",
      onSelect: () => actions.close!(delivery.id),
    });
  }
  // A failed delivery is otherwise a dead end: its dependents wait on a
  // completion that never comes, so offer the way back into the queue. A
  // *completed* one is not offered — re-running it would drop the summary its
  // dependents were dispatched with (the server refuses it too).
  if (actions.retry && isDeliveryTerminal(delivery.status) && delivery.status !== "completed") {
    entries.push({
      type: "item",
      label: "Retry delivery",
      icon: RotateCcw,
      hint: "starts a fresh workflow",
      onSelect: () => actions.retry!(delivery.id),
    });
  }
  // `priorWorkflowIds` too: a retried delivery has a null workflowId but real
  // work behind it, and removing it would drop that spend from the program.
  if (actions.remove && !delivery.workflowId && !delivery.priorWorkflowIds.length) {
    entries.push({
      type: "item",
      label: "Remove delivery",
      icon: Trash2,
      danger: true,
      disabled: program.deliveries.some((d) => d.dependsOn.includes(delivery.id)),
      onSelect: () => actions.remove!(delivery.id),
    });
  }

  const ws = delivery.ws;
  if (ws) {
    const go = (patch: NavPatch) => {
      ctx.setActiveWorkspace(ws);
      ctx.nav({ ws, ...patch });
    };
    entries.push({ type: "separator" });
    if (delivery.workflowId) {
      entries.push({
        type: "item",
        label: "Open workflow in Orchestrate",
        icon: Network,
        hint: delivery.projectName,
        onSelect: () =>
          go({ mode: "orchestrate", orchestrate: { tab: "workflows", workflow: delivery.workflowId } }),
      });
    }
    entries.push(...projectMenuEntries(ws, ctx));
  }

  entries.push(
    { type: "separator" },
    {
      type: "item",
      label: "Copy link to this delivery",
      icon: Link2,
      onSelect: () => ctx.copy(hubDeepLink(program.id, delivery.id)),
    },
    {
      type: "item",
      label: "Copy project path",
      icon: ClipboardCopy,
      hint: delivery.projectRoot,
      onSelect: () => ctx.copy(delivery.projectRoot),
    },
  );
  return entries;
}

/** The standard block for one program row. */
export function programMenuEntries(
  program: Program,
  ctx: HubMenuContext,
  actions: ProgramMenuActions = {},
): MenuEntry[] {
  const live = isProgramLive(program.status);
  const ready = program.deliveries.filter(
    (d) => deliveryReadiness(program, d, actions.others ?? []).ready,
  ).length;
  const entries: MenuEntry[] = [{ type: "heading", label: program.name }];
  if (actions.dispatch) {
    entries.push({
      type: "item",
      label: "Dispatch ready deliveries",
      icon: Rocket,
      disabled: ready === 0,
      hint: ready ? `${ready} ready` : "nothing ready",
      onSelect: actions.dispatch,
    });
  }
  if (actions.startManager && !program.managerRunId) {
    entries.push({
      type: "item",
      label: "Start a program manager",
      icon: Bot,
      disabled: !live,
      onSelect: actions.startManager,
    });
  }
  if (actions.setPaused && live) {
    entries.push({
      type: "item",
      label: program.status === "paused" ? "Resume program" : "Pause program",
      icon: program.status === "paused" ? Play : Pause,
      onSelect: () => actions.setPaused!(program.status !== "paused"),
    });
  }
  if (actions.cancel && live) {
    entries.push({
      type: "item",
      label: "Cancel program",
      icon: Ban,
      danger: true,
      onSelect: actions.cancel,
    });
  }
  if (actions.remove && !live) {
    entries.push({
      type: "item",
      label: "Remove from the hub",
      icon: Trash2,
      danger: true,
      hint: "keeps the project work",
      onSelect: actions.remove,
    });
  }
  entries.push(
    { type: "separator" },
    {
      type: "item",
      label: "Copy link to this program",
      icon: Link2,
      onSelect: () => ctx.copy(hubDeepLink(program.id)),
    },
    {
      type: "item",
      label: "Copy program id",
      icon: ClipboardCopy,
      hint: program.id,
      onSelect: () => ctx.copy(program.id),
    },
  );
  return entries;
}

/** One-line "why is this delivery not moving" text for a row's subtitle. */
export function deliveryHint(program: Program, delivery: ProgramDelivery): string | null {
  if (delivery.status !== "pending") return null;
  const blockers = deliveryBlockers(program, delivery);
  if (!blockers.length) return null;
  const names = blockers.map((id) => deliveryById(program, id)?.projectName ?? id);
  return `waiting on ${names.join(", ")}`;
}

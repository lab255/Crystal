import type { AgentRun, TerminalInfo } from "@crystal/core";
import { INTERACTIVE_PROMPT_DELAY_MS, type AgentManager, type InteractiveStartParams } from "./agent-manager.js";
import type { TerminalManager } from "./terminal-manager.js";

export { INTERACTIVE_PROMPT_DELAY_MS };

export interface InteractiveLaunch {
  run: AgentRun;
  terminal: TerminalInfo;
}

/**
 * The one way an interactive run comes to life: prepare the run (record +
 * mcp-config + argv), host the native Claude TUI on a PTY, bind the two, and
 * type the opening prompt in once the TUI has mounted. Used by the
 * `agent.interactive` bridge handler and by the workflow engine's manager
 * launcher — the hub composes the same steps itself because its runs and its
 * terminals live on different hosts.
 */
export async function launchInteractiveRun(
  agents: AgentManager,
  terminals: TerminalManager,
  params: InteractiveStartParams & { cols?: number; rows?: number; title?: string | null },
  terminalWs: string | null = null,
): Promise<InteractiveLaunch> {
  const { cols, rows, title, ...startParams } = params;
  const plan = await agents.prepareInteractive(startParams);
  const terminal = terminals.create({
    cwd: plan.cwd,
    trustedCwd: true,
    cols,
    rows,
    command: { file: plan.file, args: plan.args, env: plan.env },
    title: title ?? "claude",
  });
  const run = await agents.bindInteractive(plan.run.id, terminal.id, terminalWs);
  if (terminal.status === "exited") {
    // Spawn failed before the exit event could see a bound run.
    await agents.settleInteractive(terminal.id, terminal.exitCode);
    return { run: (await agents.get(run.id)) ?? run, terminal };
  }
  if (plan.prompt) {
    terminals.writeWhenReady(terminal.id, plan.prompt, INTERACTIVE_PROMPT_DELAY_MS);
  }
  return { run, terminal };
}

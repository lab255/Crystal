import type { TaskItem, WorkspaceInfo } from "@crystal/core";

/**
 * Build the agent prompt for a task: the task text plus any workspace context
 * Crystal knows about (linked architecture nodes, repos, files).
 */
export function buildTaskPrompt(task: TaskItem, info: WorkspaceInfo | null): string {
  const lines: string[] = [task.title.trim()];
  if (task.description.trim()) {
    lines.push("", task.description.trim());
  }

  const context: string[] = [];
  if (info) {
    const nodes = info.architectures
      .flatMap((a) => a.graph.nodes)
      .filter((n) => task.links.nodeIds.includes(n.id));
    if (nodes.length) {
      context.push(
        `Architecture components in scope: ${nodes
          .map((n) => `${n.label} (${n.kind}${n.description ? `: ${n.description}` : ""})`)
          .join(", ")}`,
      );
    }
    const repos = info.manifest.repos.filter((r) => task.links.repoIds.includes(r.id));
    if (repos.length) {
      context.push(`Repos in scope: ${repos.map((r) => `${r.name} at ${r.path}`).join(", ")}`);
    }
  }
  if (task.links.files.length) {
    context.push(`Relevant files: ${task.links.files.join(", ")}`);
  }
  if (context.length) {
    lines.push("", "Context from Crystal:", ...context.map((c) => `- ${c}`));
  }
  return lines.join("\n");
}

export function formatCost(costUsd: number | null | undefined): string {
  if (costUsd == null) return "—";
  return costUsd < 0.01 ? "<$0.01" : `$${costUsd.toFixed(2)}`;
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

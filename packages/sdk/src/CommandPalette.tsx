import { useEffect, useMemo, useState } from "react";
import {
  Bot,
  Boxes,
  Code2,
  KanbanSquare,
  LayoutGrid,
  Plus,
  TerminalSquare,
  type LucideIcon,
} from "lucide-react";
import { useWorkspace } from "@crystal/client";
import { Dialog, DialogContent, Kbd, cn } from "@crystal/ui";
import type { CrystalMode } from "./modes.js";

export interface Command {
  id: string;
  title: string;
  icon: LucideIcon;
  hint?: string;
  run: () => void;
}

export function CommandPalette({
  open,
  onOpenChange,
  onSwitchMode,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSwitchMode: (mode: CrystalMode) => void;
}) {
  const createArchitecture = useWorkspace((s) => s.createArchitecture);
  const createProject = useWorkspace((s) => s.createProject);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);

  useEffect(() => {
    if (open) {
      setQuery("");
      setHighlight(0);
    }
  }, [open]);

  const commands: Command[] = useMemo(
    () => [
      {
        id: "mode.projects",
        title: "Go to Projects",
        icon: LayoutGrid,
        hint: "Ctrl+1",
        run: () => onSwitchMode("projects"),
      },
      {
        id: "mode.architect",
        title: "Go to Architecture",
        icon: Boxes,
        hint: "Ctrl+2",
        run: () => onSwitchMode("architect"),
      },
      {
        id: "mode.orchestrate",
        title: "Go to Orchestrate",
        icon: KanbanSquare,
        hint: "Ctrl+3",
        run: () => onSwitchMode("orchestrate"),
      },
      {
        id: "mode.code",
        title: "Go to Code",
        icon: Code2,
        hint: "Ctrl+4",
        run: () => onSwitchMode("code"),
      },
      {
        id: "terminal.new",
        title: "New terminal (active workspace)",
        icon: TerminalSquare,
        run: () => window.dispatchEvent(new CustomEvent("crystal:open-terminal", { detail: {} })),
      },
      {
        id: "terminal.agent",
        title: "New agent console (active workspace)",
        icon: Bot,
        run: () =>
          window.dispatchEvent(
            new CustomEvent("crystal:open-terminal", { detail: { kind: "agent" } }),
          ),
      },
      {
        id: "arch.new",
        title: "New architecture diagram",
        icon: Plus,
        run: () => {
          onSwitchMode("architect");
          void createArchitecture("Untitled architecture");
        },
      },
      {
        id: "project.new",
        title: "New project board",
        icon: Plus,
        run: () => {
          onSwitchMode("orchestrate");
          void createProject("Untitled project");
        },
      },
    ],
    [onSwitchMode, createArchitecture, createProject],
  );

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter((c) => c.title.toLowerCase().includes(q));
  }, [commands, query]);

  useEffect(() => setHighlight(0), [query]);

  function run(cmd: Command): void {
    onOpenChange(false);
    cmd.run();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Command palette" className="top-[30%] w-[480px]">
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setHighlight((h) => Math.min(h + 1, results.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setHighlight((h) => Math.max(h - 1, 0));
            } else if (e.key === "Enter" && results[highlight]) {
              run(results[highlight]);
            }
          }}
          placeholder="Type a command…"
          className="mb-2 w-full rounded-lg border border-edge bg-surface-1 px-2.5 py-1.5 text-sm text-ink outline-none placeholder:text-ink-faint focus:border-crystal-500/60"
        />
        <div className="max-h-72 space-y-0.5 overflow-y-auto">
          {results.map((cmd, i) => {
            const Icon = cmd.icon;
            return (
              <button
                key={cmd.id}
                type="button"
                onClick={() => run(cmd)}
                onMouseEnter={() => setHighlight(i)}
                className={cn(
                  "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px]",
                  i === highlight ? "bg-crystal-500/20 text-ink" : "text-ink-muted",
                )}
              >
                <Icon className="h-4 w-4 shrink-0 text-ink-faint" />
                <span className="flex-1">{cmd.title}</span>
                {cmd.hint ? <Kbd>{cmd.hint}</Kbd> : null}
              </button>
            );
          })}
          {results.length === 0 ? (
            <div className="px-3 py-6 text-center text-xs text-ink-faint">No commands</div>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

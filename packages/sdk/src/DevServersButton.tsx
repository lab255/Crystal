import { useCallback, useEffect, useState } from "react";
import {
  ExternalLink,
  Play,
  RotateCw,
  ServerCog,
  Square,
  TerminalSquare,
} from "lucide-react";
import type { DevServerInfo } from "@crystal/core";
import { useCrystal, useTerminals, useWorkspaces } from "@crystal/client";
import {
  Badge,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
  Spinner,
  cn,
} from "@crystal/ui";

/**
 * The rail's dev-server launcher: every detected candidate (monorepo-aware,
 * see core/dev-server.ts) with one-click start/stop/restart. A running server
 * is an ordinary PTY terminal — the row's terminal button reveals its output
 * in the panel, and the sniffed URL opens in the browser. Rows are plain
 * elements (not menu items) so the panel stays open across actions.
 */
export function DevServersButton() {
  const { client } = useCrystal();
  const activeWs = useWorkspaces((s) => s.activeId);
  const focusTerminal = useTerminals((s) => s.focusTerminal);
  const [open, setOpen] = useState(false);
  const [servers, setServers] = useState<DevServerInfo[] | null>(null);
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    client
      .request("devservers.list", {})
      .then(({ servers: next }) => {
        setServers(next);
        setError(null);
      })
      .catch((err: Error) => setError(err.message));
  }, [client]);

  // Keep the running dot live even while closed; refetch on server events.
  useEffect(() => {
    setServers(null);
    refresh();
    return client.events.on("devservers.changed", ({ ws }) => {
      if (ws === activeWs) refresh();
    });
  }, [client, refresh, activeWs]);

  const act = useCallback(
    async (id: string, verb: "start" | "stop" | "restart") => {
      setBusy((b) => new Set(b).add(id));
      setError(null);
      try {
        if (verb === "start") await client.request("devservers.start", { id });
        else if (verb === "stop") await client.request("devservers.stop", { id });
        else await client.request("devservers.restart", { id });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy((b) => {
          const next = new Set(b);
          next.delete(id);
          return next;
        });
        refresh();
      }
    },
    [client, refresh],
  );

  const runningCount = servers?.filter((s) => s.status === "running").length ?? 0;

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) refresh();
      }}
    >
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Dev servers"
          title="Dev servers"
          className={cn(
            "relative flex h-9 w-9 items-center justify-center rounded-lg transition-colors",
            open
              ? "bg-crystal-500/20 text-crystal-300"
              : "text-ink-faint hover:bg-surface-3 hover:text-ink-muted",
          )}
        >
          <ServerCog className="h-4.5 w-4.5" />
          {runningCount > 0 ? (
            <span className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-ok px-0.5 text-[9px] font-bold text-surface-0">
              {runningCount}
            </span>
          ) : null}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="right" align="end" className="w-96 max-w-[90vw]">
        <DropdownMenuLabel>Dev servers</DropdownMenuLabel>
        {error ? (
          <div className="mx-1 mb-1 rounded-md border border-danger/30 bg-danger/10 px-2 py-1 text-[11px] text-danger">
            {error}
          </div>
        ) : null}
        {servers === null ? (
          <div className="flex justify-center py-4">
            <Spinner />
          </div>
        ) : servers.length === 0 ? (
          <div className="px-2 py-2 text-[11px] text-ink-faint">
            No dev scripts detected in this workspace's packages.
          </div>
        ) : (
          <div className="max-h-96 overflow-y-auto">
            {servers.map((s) => (
              <ServerRow
                key={s.id}
                server={s}
                busy={busy.has(s.id)}
                onAct={act}
                onShowTerminal={() => {
                  if (s.terminalId && activeWs) {
                    void focusTerminal(activeWs, s.terminalId);
                    setOpen(false);
                  }
                }}
              />
            ))}
          </div>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const KIND_LABEL: Record<DevServerInfo["kind"], string> = {
  app: "app",
  storybook: "storybook",
  docs: "docs",
  api: "api",
  task: "script",
};

function ServerRow({
  server,
  busy,
  onAct,
  onShowTerminal,
}: {
  server: DevServerInfo;
  busy: boolean;
  onAct: (id: string, verb: "start" | "stop" | "restart") => void;
  onShowTerminal: () => void;
}) {
  const running = server.status === "running";
  return (
    <div className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-surface-2">
      <span
        className={cn(
          "h-1.5 w-1.5 shrink-0 rounded-full",
          running ? "bg-ok" : "bg-edge-strong",
        )}
      />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 truncate text-xs text-ink" title={`${server.dir} · ${server.command}`}>
            {server.pkgName ?? (server.dir === "." ? "workspace root" : server.dir)}
          </span>
          <Badge className="shrink-0 font-mono">{server.script}</Badge>
          <Badge tone={running ? "emerald" : "slate"} className="shrink-0">
            {running ? "running" : KIND_LABEL[server.kind]}
          </Badge>
        </div>
        {running && server.url ? (
          <a
            href={server.url}
            target="_blank"
            rel="noreferrer"
            className="mt-0.5 flex items-center gap-1 text-[10px] text-crystal-300 hover:underline"
          >
            <ExternalLink className="h-2.5 w-2.5" />
            {server.url}
          </a>
        ) : null}
      </div>
      <span className="flex shrink-0 items-center gap-0.5">
        {busy ? <Spinner className="h-3.5 w-3.5" /> : null}
        {running ? (
          <>
            <IconAction
              label={`Restart ${server.script}`}
              disabled={busy}
              onClick={() => onAct(server.id, "restart")}
            >
              <RotateCw className="h-3 w-3" />
            </IconAction>
            <IconAction
              label={`Stop ${server.script}`}
              disabled={busy}
              onClick={() => onAct(server.id, "stop")}
            >
              <Square className="h-3 w-3" />
            </IconAction>
            <IconAction label="Show output in the terminal panel" onClick={onShowTerminal}>
              <TerminalSquare className="h-3 w-3" />
            </IconAction>
          </>
        ) : (
          <IconAction
            label={`Run ${server.script}`}
            disabled={busy}
            onClick={() => onAct(server.id, "start")}
          >
            <Play className="h-3 w-3" />
          </IconAction>
        )}
      </span>
    </div>
  );
}

function IconAction({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="rounded p-1 text-ink-faint hover:bg-surface-3 hover:text-ink disabled:opacity-40"
    >
      {children}
    </button>
  );
}

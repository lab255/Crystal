import { useEffect, useState } from "react";
import { Plug, Server, Unplug, X } from "lucide-react";
import { DEFAULT_SERVER_SID } from "@crystal/core";
import {
  listBridgeInstances,
  shellBridgeEndpoint,
  sidForEndpoint,
  useCrystal,
  useFleetConnections,
  type BridgeInstance,
} from "@crystal/client";
import { Button, Dialog, DialogClose, DialogContent, Input, StatusDot, cn } from "@crystal/ui";

/**
 * Connect this client to another bridge server (the fleet layer).
 *
 * Desktop: lists the live local servers advertising themselves in
 * `~/.crystal/instances` — minus the shell's own supervised sidecar and the
 * server the default connection already reaches — and connects on click
 * (local pipes need no token). Web (and for remote bridges anywhere): a
 * manual `ws(s)://` endpoint plus an optional bearer token, stored
 * per-endpoint. Existing added connections are listed with their live state
 * and can be removed (disconnect + forget endpoint and token).
 */
export function ConnectBridgeDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { fleet } = useCrystal();
  const connections = useFleetConnections();

  const [instances, setInstances] = useState<BridgeInstance[] | null>(null);
  const [endpoint, setEndpoint] = useState("");
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);

  const defaultConn = connections.find((c) => c.sid === DEFAULT_SERVER_SID);
  const added = connections.filter((c) => c.sid !== DEFAULT_SERVER_SID);
  const connectedSids = new Set(connections.map((c) => c.sid));

  // Discovery (desktop only — resolves to [] in a plain browser).
  useEffect(() => {
    if (!open) return;
    setEndpoint("");
    setToken("");
    setError(null);
    setInstances(null);
    let cancelled = false;
    void Promise.all([listBridgeInstances(), shellBridgeEndpoint()]).then(
      ([all, ownPipe]) => {
        if (cancelled) return;
        setInstances(
          all.filter(
            (inst) =>
              inst.alive === true &&
              typeof inst.pipe === "string" &&
              // Not the connection we already are: neither the shell's own
              // sidecar pipe nor the server the default client reached.
              inst.pipe !== ownPipe &&
              (inst.serverId == null || inst.serverId !== defaultConn?.serverId) &&
              !connectedSids.has(sidForEndpoint(inst.pipe)),
          ),
        );
      },
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- snapshot on open
  }, [open]);

  function connect(target: string, withToken?: string | null, label?: string): void {
    const trimmed = target.trim();
    if (!trimmed) return;
    setError(null);
    try {
      fleet.addConnection(trimmed, withToken?.trim() || null, label);
      onOpenChange(false);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Connect to bridge"
        description="Reach another Crystal server's workspaces from this window."
        className="w-[480px]"
      >
        <div className="space-y-3">
          {instances && instances.length > 0 ? (
            <div>
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
                Running on this machine
              </div>
              <div className="space-y-0.5">
                {instances.map((inst) => (
                  <button
                    key={inst.file ?? inst.pipe}
                    type="button"
                    onClick={() => connect(inst.pipe!, null, inst.name)}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-ink-muted hover:bg-surface-3 hover:text-ink"
                  >
                    <Server className="h-3.5 w-3.5 shrink-0 text-crystal-300" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-ink">
                        {inst.name ?? `pid ${inst.pid ?? "?"}`}
                      </span>
                      <span className="block truncate text-[10px] text-ink-faint">
                        {(inst.workspaces?.map((w) => w.name) ?? inst.roots ?? []).join(" · ") ||
                          inst.pipe}
                      </span>
                    </span>
                    <Plug className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          <form
            onSubmit={(e) => {
              e.preventDefault();
              connect(endpoint, token);
            }}
            className="space-y-2"
          >
            <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
              By endpoint
            </div>
            <Input
              value={endpoint}
              onChange={(e) => {
                setEndpoint(e.target.value);
                setError(null);
              }}
              placeholder="ws://host:4517/crystal or a local pipe path"
              spellCheck={false}
            />
            <Input
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="Bearer token (optional — remote bridges only)"
              type="password"
              spellCheck={false}
            />
            {error ? <div className="text-[11px] text-danger">{error}</div> : null}
            <div className="flex justify-end gap-2">
              <DialogClose asChild>
                <Button variant="ghost" size="sm">
                  Cancel
                </Button>
              </DialogClose>
              <Button type="submit" variant="primary" size="sm" disabled={!endpoint.trim()}>
                <Plug className="h-3.5 w-3.5" /> Connect
              </Button>
            </div>
          </form>

          {added.length > 0 ? (
            <div>
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
                Connected bridges
              </div>
              <div className="space-y-0.5">
                {added.map((c) => (
                  <div
                    key={c.sid}
                    className="flex items-center gap-2 rounded-md px-2 py-1 text-xs"
                  >
                    <StatusDot
                      status={
                        c.state === "open"
                          ? "completed"
                          : c.state === "connecting"
                            ? "running"
                            : "failed"
                      }
                    />
                    <span className="min-w-0 flex-1">
                      <span className={cn("block truncate", c.state === "open" ? "text-ink" : "text-ink-muted")}>
                        {c.label}
                      </span>
                      <span className="block truncate text-[10px] text-ink-faint">
                        {c.endpoint}
                      </span>
                    </span>
                    {c.state !== "open" ? (
                      <Unplug className="h-3 w-3 shrink-0 text-danger" />
                    ) : null}
                    <button
                      type="button"
                      aria-label={`Remove bridge ${c.label}`}
                      title="Disconnect and forget (also forgets its token)"
                      onClick={() => fleet.removeConnection(c.sid)}
                      className="shrink-0 rounded p-0.5 text-ink-faint hover:bg-surface-3 hover:text-danger"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

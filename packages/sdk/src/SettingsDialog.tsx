import { useEffect, useState } from "react";
import { Copy, DownloadCloud, Globe, Monitor, Moon, Sun } from "lucide-react";
import { PUBLISH_PASSWORD_MIN_LEN, type PublishStatus } from "@crystal/core";
import {
  checkForDesktopUpdateNow,
  useCrystal,
  useDesktopUpdate,
  useSettings,
  type EnterBehavior,
  type ThemePreference,
} from "@crystal/client";
import { Dialog, DialogContent, Input, Spinner, Switch, cn } from "@crystal/ui";

/**
 * App settings — machine-local preferences (theme, composer keymap, updates).
 * Everything applies immediately; there is no save step. Workspace-scoped
 * configuration lives with its feature, not here.
 */
export function SettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const theme = useSettings((s) => s.theme);
  const enterToSend = useSettings((s) => s.enterToSend);
  const set = useSettings((s) => s.set);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Settings" className="w-[440px]">
        <div className="flex flex-col gap-5 p-4">
          <Section label="Appearance">
            <Segmented<ThemePreference>
              value={theme}
              onChange={(v) => set({ theme: v })}
              options={[
                { value: "light", label: "Light", icon: <Sun className="h-3.5 w-3.5" /> },
                { value: "dark", label: "Dark", icon: <Moon className="h-3.5 w-3.5" /> },
                { value: "system", label: "System", icon: <Monitor className="h-3.5 w-3.5" /> },
              ]}
            />
          </Section>

          <Section
            label="Dispatch key"
            hint="Ctrl/Cmd+Enter always sends; Shift/Alt+Enter always inserts a newline."
          >
            <Segmented<EnterBehavior>
              value={enterToSend}
              onChange={(v) => set({ enterToSend: v })}
              options={[
                { value: "mod-enter", label: "Ctrl+Enter sends" },
                { value: "enter", label: "Enter sends" },
              ]}
            />
          </Section>

          <Section label="Updates">
            <UpdateRow />
          </Section>

          <Section
            label="Publish server"
            hint="Relays this bridge through Cloudflare so other devices (and teammates, later) can reach it. Password required; attempts are rate-limited at the relay."
          >
            <PublishSection active={open} />
          </Section>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Section({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-[11px] font-medium uppercase tracking-wide text-ink-faint">{label}</div>
      {children}
      {hint ? <div className="text-[11px] text-ink-faint">{hint}</div> : null}
    </div>
  );
}

function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string; icon?: React.ReactNode }[];
}) {
  return (
    <div className="flex w-fit items-center gap-0.5 rounded-lg bg-surface-2 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          aria-pressed={value === o.value}
          className={cn(
            "flex h-6.5 items-center gap-1.5 rounded-md px-2.5 text-xs transition-colors",
            value === o.value
              ? "bg-surface-active font-medium text-ink shadow-sm"
              : "text-ink-muted hover:text-ink",
          )}
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Publish toggle — drives `publish.configure` on the active connection's
 * server. Degrades to a notice when the server predates the feature. The
 * password is write-only: it is sent to the relay, never read back.
 */
function PublishSection({ active }: { active: boolean }) {
  const { client } = useCrystal();
  const [status, setStatus] = useState<PublishStatus | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [relayUrl, setRelayUrl] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    client
      .request("publish.status", {})
      .then((s) => {
        if (cancelled) return;
        setStatus(s);
        setRelayUrl((v) => v || s.relayUrl || "");
      })
      .catch(() => !cancelled && setUnsupported(true));
    return () => {
      cancelled = true;
    };
  }, [active, client]);

  if (unsupported) {
    return <div className="text-xs text-ink-muted">This bridge server doesn’t support publishing yet.</div>;
  }
  if (!status) {
    return <Spinner className="h-3.5 w-3.5" />;
  }

  async function configure(patch: { enabled?: boolean; relayUrl?: string; password?: string }) {
    setBusy(true);
    setError(null);
    try {
      const next = await client.request("publish.configure", patch);
      setStatus(next);
      setPassword("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const needsPassword = !status.hasPassword && password.length < PUBLISH_PASSWORD_MIN_LEN;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2.5">
        <Switch
          checked={status.enabled}
          disabled={busy || (!status.enabled && (!relayUrl.trim() || needsPassword))}
          onChange={(on) =>
            void configure(
              on
                ? {
                    enabled: true,
                    relayUrl: relayUrl.trim(),
                    ...(password ? { password } : {}),
                  }
                : { enabled: false },
            )
          }
        />
        <span className="text-xs text-ink">{status.enabled ? "Published" : "Not published"}</span>
        {status.enabled ? (
          <span className={cn("flex items-center gap-1 text-[11px]", status.connected ? "text-ok" : "text-warn")}>
            <Globe className="h-3 w-3" />
            {status.connected
              ? `relay connected · ${status.clients} client${status.clients === 1 ? "" : "s"}`
              : "connecting to relay…"}
          </span>
        ) : null}
      </div>
      <div className="flex items-center gap-2">
        <Input
          value={relayUrl}
          onChange={(e) => setRelayUrl(e.target.value)}
          placeholder="Relay URL (https://crystal-relay.….workers.dev)"
          className="h-7 flex-1 text-xs"
          disabled={busy || status.enabled}
        />
        <Input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={
            status.hasPassword ? "New access password (optional)" : `Access password (min ${PUBLISH_PASSWORD_MIN_LEN})`
          }
          className="h-7 w-52 text-xs"
          disabled={busy}
        />
      </div>
      {status.enabled && password.length >= PUBLISH_PASSWORD_MIN_LEN ? (
        <button
          type="button"
          onClick={() => void configure({ password })}
          className="w-fit rounded-md bg-surface-2 px-2.5 py-1 text-xs text-ink-muted hover:bg-surface-3 hover:text-ink"
          disabled={busy}
        >
          Update password
        </button>
      ) : null}
      {status.enabled && status.publicUrl ? (
        <div className="flex items-center gap-1.5 text-[11px] text-ink-muted">
          <span className="truncate font-mono">{status.publicUrl}</span>
          <button
            type="button"
            aria-label="Copy public URL"
            onClick={() => {
              void navigator.clipboard.writeText(status.publicUrl ?? "").then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              });
            }}
            className="rounded p-0.5 text-ink-faint hover:bg-surface-3 hover:text-ink"
          >
            <Copy className="h-3 w-3" />
          </button>
          {copied ? <span className="text-ok">copied</span> : null}
        </div>
      ) : null}
      {error ? <div className="text-[11px] text-danger">{error}</div> : null}
    </div>
  );
}

/** Same updater store the footer badge uses — this is just the settings-page face of it. */
function UpdateRow() {
  const supported = useDesktopUpdate((s) => s.supported);
  const phase = useDesktopUpdate((s) => s.phase);
  const pending = useDesktopUpdate((s) => s.version);
  const updateError = useDesktopUpdate((s) => s.error);
  const version =
    typeof __CRYSTAL_VERSION__ === "string" && __CRYSTAL_VERSION__ ? __CRYSTAL_VERSION__ : "dev";

  if (!supported) {
    return (
      <div className="text-xs text-ink-muted">
        Crystal {version} — updates are managed by the desktop app; in the browser you get
        whatever the server serves.
      </div>
    );
  }
  const busy = phase === "checking" || phase === "downloading" || phase === "restarting";
  const status =
    phase === "checking"
      ? "checking…"
      : phase === "downloading"
        ? `downloading ${pending ?? "update"}…`
        : phase === "restarting"
          ? "restarting…"
          : phase === "uptodate"
            ? "up to date"
            : phase === "error"
              ? `update check failed: ${updateError ?? "unknown error"}`
              : null;
  return (
    <div className="flex items-center gap-3">
      <span className="text-xs text-ink">Crystal {version}</span>
      <button
        type="button"
        onClick={() => void checkForDesktopUpdateNow()}
        disabled={busy}
        className={cn(
          "flex items-center gap-1.5 rounded-md bg-surface-2 px-2.5 py-1 text-xs text-ink-muted transition-colors hover:bg-surface-3 hover:text-ink",
          busy && "cursor-default opacity-70",
        )}
      >
        {busy ? <Spinner className="h-3 w-3" /> : <DownloadCloud className="h-3 w-3" />}
        Check for updates
      </button>
      {status ? (
        <span className={cn("text-[11px]", phase === "error" ? "text-warn" : "text-ink-faint")}>
          {status}
        </span>
      ) : null}
    </div>
  );
}

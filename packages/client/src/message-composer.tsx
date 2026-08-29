import { useState } from "react";
import { Send } from "lucide-react";
import { Button, Textarea, cn } from "@crystal/ui";
import { useComposerKeydown, useSettings } from "./settings.js";

/**
 * What a send resolved to. `queued: true` means the message could not be
 * delivered mid-turn and waits for the turn to settle (the server's
 * `deliver` semantics) — the composer surfaces that so the user knows their
 * message landed but hasn't been read yet. `status: "recorded"` is the
 * delivery failure the queued notice must never mask: the target session can
 * never receive the text (cancelled chain, no session) — the composer keeps
 * the draft and says so instead of pretending it queued.
 */
export interface ComposerSendResult {
  queued?: boolean;
  status?: "resumed" | "queued" | "recorded";
}

/**
 * THE message composer: textarea + the settings-store Enter keymap + Send +
 * queued notice. Four near-identical copies exist across the hub, workflow
 * and orchestrator panes; they all collapse onto this one. It is deliberately
 * routing-blind — `onSend` decides whether the text goes to a workflow
 * manager, a program manager, or a plain run.
 */
export function MessageComposer({
  onSend,
  disabled = false,
  placeholder,
  /** Optional hint shown beneath the composer while a send is in flight. */
  busyHint,
  ariaLabel = "Message the agent",
  className,
}: {
  onSend: (text: string) => Promise<ComposerSendResult | void>;
  disabled?: boolean;
  placeholder?: string;
  busyHint?: string;
  ariaLabel?: string;
  className?: string;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: "queued" | "error"; text: string } | null>(null);
  const enterToSend = useSettings((s) => s.enterToSend);
  const sendHint = enterToSend === "enter" ? "Enter to send" : "Ctrl+Enter to send";
  const onComposerKey = useComposerKeydown(() => void send());

  async function send(): Promise<void> {
    const t = text.trim();
    if (!t || busy || disabled) return;
    setBusy(true);
    setNotice(null);
    try {
      const result = await onSend(t);
      if (result && result.status === "recorded") {
        // NOT delivered and never will be — keep the draft so the user can
        // take it somewhere that is alive (compact, a fresh session).
        setNotice({
          kind: "error",
          text: "Not delivered — this session has ended and can't receive messages.",
        });
        return;
      }
      setText("");
      if (result && result.queued) {
        setNotice({ kind: "queued", text: "Queued — delivers when the turn settles." });
      }
    } catch (err) {
      setNotice({ kind: "error", text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={cn("bg-surface-1 p-2", className)}>
      <div className="flex items-end gap-2">
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onComposerKey}
          rows={2}
          disabled={disabled}
          placeholder={`${placeholder ?? "Message this run…"} (${sendHint})`}
          aria-label={ariaLabel}
          className="min-h-0 flex-1"
        />
        <Button
          variant="primary"
          size="sm"
          disabled={disabled || busy || !text.trim()}
          onClick={() => void send()}
        >
          <Send className="h-3 w-3" /> Send
        </Button>
      </div>
      {busy && busyHint ? <p className="mt-1 text-[10px] text-ink-faint">{busyHint}</p> : null}
      {notice ? (
        <p
          className={cn(
            "mt-1 text-[10px]",
            notice.kind === "error" ? "text-danger" : "text-ink-faint",
          )}
        >
          {notice.text}
        </p>
      ) : null}
    </div>
  );
}

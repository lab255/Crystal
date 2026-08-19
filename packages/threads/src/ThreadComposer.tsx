import { useCallback, useState } from "react";
import type { AgentRun } from "@crystal/core";
import {
  MessageComposer,
  messageRun,
  useCrystal,
  type ComposerSendResult,
} from "@crystal/client";

/**
 * The thread's composer: routes through {@link messageRun} (workflow/program
 * tag routing) and surfaces the typed steer receipt. The `recorded` status is
 * the load-bearing one — the shared MessageComposer keeps the draft and says
 * the session can never receive it; this wrapper must never collapse the
 * status into a boolean.
 */
export function ThreadComposer({
  run,
  disabled = false,
  onDelivered,
  className,
}: {
  /** The chain's face turn — the conversation being steered. */
  run: AgentRun;
  disabled?: boolean;
  /** The resumed turn's id, when the send minted one — follow it. */
  onDelivered?: (runId: string | null) => void;
  className?: string;
}) {
  const { client } = useCrystal();
  const [receipt, setReceipt] = useState<string | null>(null);

  const send = useCallback(
    async (text: string): Promise<ComposerSendResult> => {
      setReceipt(null);
      const result = await messageRun(client, run, text);
      if (result.status !== "recorded") onDelivered?.(result.runId ?? null);
      if (result.queued && typeof result.wakeExpected === "boolean") {
        setReceipt(
          result.wakeExpected
            ? "Queued — the manager wakes on the next settlement."
            : "Queued — no wake expected; it reads this when next resumed.",
        );
        // The receipt above replaces the shared composer's generic queue note.
        return { ...result, queued: false };
      }
      return result;
    },
    [client, run, onDelivered],
  );

  return (
    <div className={className}>
      {receipt ? <p className="px-2 pt-1 text-[10px] text-ink-faint">{receipt}</p> : null}
      <MessageComposer
        onSend={send}
        disabled={disabled}
        placeholder="Message this thread…"
        ariaLabel="Message this thread"
      />
    </div>
  );
}

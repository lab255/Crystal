import type { ReactNode } from "react";
import { cn } from "../cn.js";

const IS_MAC =
  typeof navigator !== "undefined" && /Mac|iP(hone|ad|od)/.test(navigator.platform);

/**
 * Hints are authored in the "Ctrl+X" vocabulary the handlers accept on every
 * platform (they also accept metaKey) — on macOS the badge shows the key the
 * user will actually press.
 */
function platformLabel(text: string): string {
  if (!IS_MAC) return text;
  return text
    .replace(/\bCtrl\+/g, "⌘")
    .replace(/\bAlt\+/g, "⌥")
    .replace(/\bShift\+/g, "⇧");
}

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        "inline-flex h-5 min-w-5 items-center justify-center rounded border border-edge-strong",
        "bg-surface-3 px-1 font-mono text-[10px] text-ink-muted",
        className,
      )}
    >
      {typeof children === "string" ? platformLabel(children) : children}
    </kbd>
  );
}

import { cn } from "../cn.js";

/**
 * Traffic-light status dot: green = all good, yellow = needs attention,
 * red = needs urgent attention, gray = idle. Matches `TrafficLight` in
 * `@crystal/core` structurally (this package stays core-free).
 */
export type TrafficLightColor = "green" | "yellow" | "red" | "gray";

const styles: Record<TrafficLightColor, string> = {
  green: "bg-ok",
  yellow: "bg-warn",
  red: "bg-danger animate-pulse",
  gray: "bg-ink-faint",
};

const labels: Record<TrafficLightColor, string> = {
  green: "on track",
  yellow: "needs attention",
  red: "urgent",
  gray: "idle",
};

export function TrafficLightDot({
  light,
  className,
}: {
  light: TrafficLightColor;
  className?: string;
}) {
  return (
    <span
      aria-label={labels[light]}
      title={labels[light]}
      className={cn("inline-block h-2 w-2 shrink-0 rounded-full", styles[light], className)}
    />
  );
}

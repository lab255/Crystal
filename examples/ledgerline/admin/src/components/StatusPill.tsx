const TONES: Record<string, string> = {
  draft: "gray",
  sent: "blue",
  paid: "green",
  void: "red",
};

export function StatusPill({ status }: { status: string }) {
  return <span className={`pill pill-${TONES[status] ?? "gray"}`}>{status}</span>;
}

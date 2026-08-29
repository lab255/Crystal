/**
 * The Overview's cross-project thread id grammar (`ProjectsLink.thread`):
 * `ws:<sid>/<ws>/<runId>` addresses a workspace thread by ANY run id in its
 * chain, `program:<id>` a coordinator (program-manager) thread. Lives in core
 * so the client's attention policy and the threads mode share one codec —
 * the client may not depend on the threads package.
 */
export type OverviewThreadRef =
  | { kind: "workspace"; sid: string; ws: string; threadId: string }
  | { kind: "program"; programId: string };

export function formatOverviewThreadId(ref: OverviewThreadRef): string {
  return ref.kind === "program"
    ? `program:${ref.programId}`
    : `ws:${ref.sid}/${ref.ws}/${ref.threadId}`;
}

export function parseOverviewThreadId(id: string): OverviewThreadRef | null {
  if (id.startsWith("program:")) {
    const programId = id.slice(8);
    return programId ? { kind: "program", programId } : null;
  }
  if (!id.startsWith("ws:")) return null;
  const value = id.slice(3);
  const first = value.indexOf("/");
  const last = value.lastIndexOf("/");
  if (first <= 0 || last <= first + 1 || last === value.length - 1) return null;
  return {
    kind: "workspace",
    sid: value.slice(0, first),
    ws: value.slice(first + 1, last),
    threadId: value.slice(last + 1),
  };
}

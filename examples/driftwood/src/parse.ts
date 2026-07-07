export interface LogLine {
  ip: string;
  method: string;
  route: string;
  status: number;
  latencyMs: number;
}

const LINE_RE = /^(\S+) (\S+) (\S+) (\d{3}) (\d+)$/;

/** Parse one access-log line; null for malformed input. */
export function parseLine(raw: string): LogLine | null {
  const m = LINE_RE.exec(raw.trim());
  if (!m) return null;
  return {
    ip: m[1]!,
    method: m[2]!,
    route: m[3]!,
    status: Number(m[4]),
    latencyMs: Number(m[5]),
  };
}

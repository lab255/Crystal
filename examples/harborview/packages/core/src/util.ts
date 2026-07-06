export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function roundCents(value: number): number {
  return Math.round(value);
}

export function uid(prefix: string): string {
  const random = Math.random().toString(36).slice(2, 10);
  const stamp = Date.now().toString(36);
  return prefix + "_" + stamp + random;
}

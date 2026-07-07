export type Result<T, E = string> = { ok: true; value: T } | { ok: false; error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

/** The value, or `fallback` when the result is an error. */
export function unwrapOr<T>(result: Result<T, unknown>, fallback: T): T {
  return result.ok ? result.value : fallback;
}

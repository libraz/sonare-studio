/**
 * Formats an unknown thrown value into a user-facing message. The wasm
 * bindings throw raw C++ exception pointers (bare numbers) for rejected
 * edits, e.g. clip overlaps; render those as an engine error code instead of
 * a meaningless integer.
 */
export function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'number') {
    return `The audio engine library rejected the operation (code ${err}).`;
  }
  return String(err);
}

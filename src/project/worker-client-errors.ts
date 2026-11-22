/** Error for a worker `error` event, falling back to `fallback` when the event has no message. */
export function workerEventError(event: ErrorEvent, fallback: string): Error {
  return new Error(event.message || fallback);
}

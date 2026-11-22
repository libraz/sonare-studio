import { MEBIBYTE } from '@/lib/bytes';
import { PayloadMemoryLimitError, type PayloadMemoryOperation } from '@/lib/payload-memory';

/** Localized templates `describeError` needs; `{required}` and `{budget}` are MiB figures. */
export interface ErrorCopy {
  /** Template with `{code}` for a bare wasm exception pointer. */
  engineRejected: string;
  memoryLimit: Readonly<Record<PayloadMemoryOperation, string>>;
}

function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in values ? String(values[key]) : match,
  );
}

/**
 * Formats an unknown thrown value into a user-facing message. The wasm
 * bindings throw raw C++ exception pointers (bare numbers) for rejected
 * edits, e.g. clip overlaps; render those as an engine error code instead of
 * a meaningless integer. Other errors carry already-localized messages.
 */
export function describeError(err: unknown, copy: ErrorCopy): string {
  if (err instanceof PayloadMemoryLimitError) {
    return fill(copy.memoryLimit[err.operation], {
      required: Math.ceil(err.requiredBytes / MEBIBYTE),
      budget: Math.floor(err.budgetBytes / MEBIBYTE),
    });
  }
  if (typeof err === 'number') return fill(copy.engineRejected, { code: err });
  return errorMessage(err);
}

/** Message of a thrown value for logs and non-localized surfaces. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** True for the error an aborted signal rejects with, whichever realm built it. */
export function isAbortError(error: unknown): boolean {
  const thrown =
    error instanceof Error ||
    (typeof DOMException !== 'undefined' && error instanceof DOMException);
  return thrown && (error as Error).name === 'AbortError';
}

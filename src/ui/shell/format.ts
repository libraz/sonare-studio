import { GIBIBYTE, KIBIBYTE, MEBIBYTE } from '@/lib/bytes';

export { formatTimestamp, type TimestampFormat } from '@/lib/date-format';

/**
 * Formats byte counts consistently across the shell.
 *
 * Storage APIs expose byte counts, while the UI has enough room to show a
 * compact binary unit. Values below one KiB stay in bytes; larger values use
 * one decimal place and the largest applicable unit.
 */
export function formatSize(bytes: number): string {
  if (bytes < KIBIBYTE) return `${bytes} B`;
  if (bytes >= GIBIBYTE) return `${(bytes / GIBIBYTE).toFixed(1)} GB`;
  if (bytes >= MEBIBYTE) return `${(bytes / MEBIBYTE).toFixed(1)} MB`;
  return `${(bytes / KIBIBYTE).toFixed(1)} KB`;
}

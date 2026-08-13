export { formatTimestamp, type TimestampFormat } from '@/lib/date-format';

/**
 * Formats byte counts consistently across the shell.
 *
 * Storage APIs expose byte counts, while the UI has enough room to show a
 * compact binary unit. Values below one KiB stay in bytes; larger values use
 * one decimal place and the largest applicable unit.
 */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

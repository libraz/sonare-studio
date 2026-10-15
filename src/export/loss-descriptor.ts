/**
 * Shared shape for what a file exporter or importer drops.
 *
 * Each format declares, next to its writer or reader, how it treats every
 * field of the document types it walks ({@link FieldDispositions}). The mapped
 * type lists every key, so a new document field is a compile error until each
 * format states whether it writes, carries or loses it. Drops are recorded into
 * a {@link LossTally} at the point they happen, and the resulting
 * {@link LossReport} is the only list any loss dialog presents.
 */

/** One dropped feature class with how often it occurred. */
export interface LossEntry<K extends string> {
  readonly kind: K;
  readonly count: number;
  /** Short identifying labels (clip names, paths), when the source has them. */
  readonly details: readonly string[];
}

/** Every feature class one export or import dropped, in the format's kind order. */
export interface LossReport<K extends string> {
  readonly entries: ReadonlyArray<LossEntry<K>>;
}

/**
 * How one format treats one document field.
 *
 * - `written`: the format's own file representation carries it.
 * - `sidecar`: a vendor extension entry carries it for a Sonare round trip.
 * - `derived`: recomputed from other carried state; nothing is lost.
 * - `not-content`: state outside what the format models (editor, session or,
 *   for a notation or MIDI file, mixing state).
 * - `{ lost }`: dropped; `count` says how many instances (default: presence).
 */
export type FieldDisposition<K extends string, V, O, C> =
  | 'written'
  | 'sidecar'
  | 'derived'
  | 'not-content'
  | { readonly lost: K; readonly count?: (value: V, owner: O, context: C) => number };

/**
 * A disposition for every key of `T`, optional keys included; a counter for an
 * optional field also receives `undefined`.
 */
export type FieldDispositions<T, K extends string, C = undefined> = {
  readonly [P in keyof Required<T>]: FieldDisposition<K, T[P & keyof T], T, C>;
};

/** Accumulates drops while a writer or reader walks a document. */
export class LossTally<K extends string> {
  private readonly counts = new Map<K, { count: number; details: string[] }>();

  constructor(private readonly order: readonly K[]) {}

  /** Records `count` drops of `kind`; non-positive counts are ignored. */
  add(kind: K, count = 1, detail?: string): void {
    if (!(count > 0)) return;
    const entry = this.counts.get(kind) ?? { count: 0, details: [] };
    entry.count += count;
    if (detail !== undefined && detail !== '') entry.details.push(detail);
    this.counts.set(kind, entry);
  }

  report(): LossReport<K> {
    return {
      entries: this.order.flatMap((kind) => {
        const entry = this.counts.get(kind);
        return entry ? [{ kind, count: entry.count, details: entry.details }] : [];
      }),
    };
  }
}

function presenceCount(value: unknown): number {
  if (value === undefined || value === null || value === false || value === 0 || value === '') {
    return 0;
  }
  return Array.isArray(value) ? value.length : 1;
}

/** Records every `lost` field of `owner` according to its dispositions. */
export function tallyFields<T extends object, K extends string, C>(
  tally: LossTally<K>,
  dispositions: FieldDispositions<T, K, C>,
  owner: T,
  context: C,
): void {
  for (const key of Object.keys(dispositions) as Array<keyof T & keyof Required<T>>) {
    const disposition = dispositions[key] as FieldDisposition<K, unknown, T, C>;
    if (typeof disposition === 'string') continue;
    const value = owner[key];
    tally.add(
      disposition.lost,
      disposition.count ? disposition.count(value, owner, context) : presenceCount(value),
    );
  }
}

/** Upper bound of detail labels shown per dialog line. */
export const MAX_LOSS_DETAILS = 3;

/**
 * Formats a report into one localized line per entry. Templates take
 * `{count}` and `{details}`; the record type requires a template per kind.
 */
export function formatLossItems<K extends string>(
  report: LossReport<K>,
  templates: Readonly<Record<K, string>>,
): string[] {
  return report.entries.map((entry) => {
    const shown = entry.details.slice(0, MAX_LOSS_DETAILS).join(', ');
    const details = entry.details.length > MAX_LOSS_DETAILS ? `${shown}, …` : shown;
    return templates[entry.kind]
      .replace(/\{count\}/g, String(entry.count))
      .replace(/\{details\}/g, details);
  });
}

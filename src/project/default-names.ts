import type { en } from '@/ui/i18n/en';
import { formatMessage } from '@/ui/i18n/format';

/** Every default name template of one language, keyed by name kind. */
export type DefaultNameTable = Readonly<
  Record<keyof (typeof en)['common']['defaultNames'], string>
>;
export type DefaultNameKey = keyof DefaultNameTable;
export type DefaultNameValues = Record<string, string | number>;

let tableSource: (() => DefaultNameTable) | null = null;

/**
 * Registers the function that returns the current language's table. Each
 * execution context calls this once from its composition root.
 */
export function registerDefaultNames(source: () => DefaultNameTable): void {
  tableSource = source;
}

/** The current language's table; throws when the context registered none. */
export function defaultNameTable(): DefaultNameTable {
  if (tableSource === null) throw new Error('Default names are not registered in this context');
  return tableSource();
}

/** Builds a default name in the language current at the moment of the call. */
export function defaultName(key: DefaultNameKey, values: DefaultNameValues = {}): string {
  return formatMessage(defaultNameTable()[key], values);
}

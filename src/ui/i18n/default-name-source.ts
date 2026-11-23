import type { DefaultNameTable } from '@/project/default-names';
import { useI18n } from './index';

/** The UI language's default-name table, read each time a name is made. */
export function uiDefaultNameSource(): () => DefaultNameTable {
  const { t } = useI18n();
  return () => t.value.common.defaultNames;
}

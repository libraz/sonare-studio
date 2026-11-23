import { type ComputedRef, computed } from 'vue';
import { useAppSettings } from '@/composables/useAppSettings';
import type { ResolvedAppLanguage } from '@/ui/settings/app-settings';
import { MESSAGES } from './messages';

export { MESSAGES };

type MessageTree = (typeof MESSAGES)[ResolvedAppLanguage];

/** The localized message tree for the active language. */
export type Messages = MessageTree;

export { formatMessage } from './format';

export function useI18n(): {
  locale: ComputedRef<ResolvedAppLanguage>;
  t: ComputedRef<MessageTree>;
} {
  const appSettings = useAppSettings();
  const messages = computed(() => MESSAGES[appSettings.resolvedLanguage.value]);
  return { locale: appSettings.resolvedLanguage, t: messages };
}

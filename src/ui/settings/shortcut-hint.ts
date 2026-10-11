import { useShortcuts } from '@/composables/useShortcuts';
import { detectPlatform, formatKeyCombo } from '@/ui/settings/key-combo';

/** Live first key binding of a shortcut action, formatted for a menu hint or tooltip key chip. */
export function shortcutHint(actionId: string): string | undefined {
  const combo = useShortcuts().keysFor(actionId)[0];
  return combo ? formatKeyCombo(combo, detectPlatform()) : undefined;
}

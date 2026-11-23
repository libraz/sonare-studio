import { beforeEach, describe, expect, it } from 'vitest';
import { ref } from 'vue';
import { useActionGuards } from '@/composables/useActionGuards';
import { useAppSettings } from '@/composables/useAppSettings';
import { dialogQueue } from '@/composables/useDialogs';
import { useI18n } from '@/ui/i18n';

describe('useActionGuards confirmation labels', () => {
  beforeEach(() => {
    dialogQueue.splice(0);
    useAppSettings().set('confirmDestructive', true);
  });

  it.each(['confirmAction', 'confirmLossAction'] as const)(
    '%s leaves an unlabelled confirm button to the localized dialog default',
    (name) => {
      const guards = useActionGuards({ busy: ref(false), errorMessage: ref('') });

      void guards[name]('Proceed?');

      expect(dialogQueue).toHaveLength(1);
      expect(dialogQueue[0]?.confirmLabel).toBe(useI18n().t.value.common.ok);
      dialogQueue[0]?.resolve(false);
    },
  );
});

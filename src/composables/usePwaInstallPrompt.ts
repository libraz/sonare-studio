import { computed, onScopeDispose, shallowRef } from 'vue';

export type PwaInstallOutcome = 'accepted' | 'dismissed';

/** The Chromium install event is intentionally not part of the DOM typings. */
export interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: PwaInstallOutcome }>;
}

/**
 * Captures the browser's one-shot PWA install event and exposes a user-initiated
 * prompt action. Browsers that do not support installation simply keep
 * `canInstall` false, so callers need no feature-specific fallback UI.
 */
export function usePwaInstallPrompt(target: EventTarget = window) {
  const pendingPrompt = shallowRef<BeforeInstallPromptEvent | null>(null);

  const onBeforeInstallPrompt = (event: Event): void => {
    event.preventDefault();
    pendingPrompt.value = event as BeforeInstallPromptEvent;
  };

  target.addEventListener('beforeinstallprompt', onBeforeInstallPrompt);
  onScopeDispose(() => target.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt));

  async function requestInstall(): Promise<PwaInstallOutcome | null> {
    const prompt = pendingPrompt.value;
    if (!prompt) return null;

    // The browser permits each captured event to be prompted at most once.
    pendingPrompt.value = null;
    await prompt.prompt();
    return (await prompt.userChoice).outcome;
  }

  return {
    canInstall: computed(() => pendingPrompt.value !== null),
    requestInstall,
  };
}

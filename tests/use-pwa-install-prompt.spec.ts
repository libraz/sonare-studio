import { describe, expect, it, vi } from 'vitest';
import { effectScope } from 'vue';
import {
  type BeforeInstallPromptEvent,
  usePwaInstallPrompt,
} from '@/composables/usePwaInstallPrompt';

function installEvent(outcome: 'accepted' | 'dismissed'): BeforeInstallPromptEvent {
  return Object.assign(new Event('beforeinstallprompt', { cancelable: true }), {
    prompt: vi.fn(async () => undefined),
    userChoice: Promise.resolve({ outcome }),
  });
}

describe('usePwaInstallPrompt', () => {
  it('captures the deferred install event and consumes it exactly once', async () => {
    const target = new EventTarget();
    const scope = effectScope();
    const prompt = scope.run(() => usePwaInstallPrompt(target))!;
    const event = installEvent('accepted');

    target.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(prompt.canInstall.value).toBe(true);
    await expect(prompt.requestInstall()).resolves.toBe('accepted');
    expect(event.prompt).toHaveBeenCalledTimes(1);
    expect(prompt.canInstall.value).toBe(false);
    await expect(prompt.requestInstall()).resolves.toBeNull();
    scope.stop();
  });

  it('removes its listener when its component scope is disposed', () => {
    const target = new EventTarget();
    const scope = effectScope();
    const prompt = scope.run(() => usePwaInstallPrompt(target))!;

    scope.stop();
    target.dispatchEvent(installEvent('dismissed'));

    expect(prompt.canInstall.value).toBe(false);
  });
});

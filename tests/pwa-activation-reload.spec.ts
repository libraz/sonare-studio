import { describe, expect, it, vi } from 'vitest';
import { applyPwaUpdateAndReload, pwaUpdateNotice, registerServiceWorker } from '@/pwa';

describe('PWA activation reload', () => {
  it('reloads only for the worker it activated, not for one that superseded it', async () => {
    const told = { postMessage: vi.fn() };
    const registration = Object.assign(new EventTarget(), {
      scope: '/',
      installing: null,
      waiting: told as typeof told | null,
      update: vi.fn(async () => undefined),
    });
    const container = Object.assign(new EventTarget(), {
      controller: {} as object,
      register: vi.fn(async () => registration),
      getRegistration: vi.fn(async () => registration),
    });
    const reload = vi.fn();
    await registerServiceWorker({
      environment: { PROD: true },
      location: { protocol: 'https:' },
      navigator: { serviceWorker: container } as unknown as Navigator,
      reload,
    });

    await applyPwaUpdateAndReload();
    expect(told.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });

    // The told worker never activates; a later release from another client takes control.
    registration.waiting = null;
    container.controller = {};
    container.dispatchEvent(new Event('controllerchange'));

    expect(reload).not.toHaveBeenCalled();
    expect(pwaUpdateNotice.value).toBe('update');
  });
});

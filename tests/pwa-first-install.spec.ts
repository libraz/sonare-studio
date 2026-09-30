import { describe, expect, it, vi } from 'vitest';

describe('first Service Worker installation', () => {
  it('does not announce an update on the first claim, but announces a subsequent release', async () => {
    vi.resetModules();
    const { registerServiceWorker, pwaUpdateNotice } = await import('@/pwa');
    const registration = Object.assign(new EventTarget(), { waiting: null });
    const container = Object.assign(new EventTarget(), {
      controller: null as object | null,
      register: vi.fn(async () => registration),
    });
    const reload = vi.fn();
    await registerServiceWorker({
      environment: { PROD: true },
      location: { protocol: 'https:' },
      navigator: { serviceWorker: container } as unknown as Navigator,
      reload,
    });

    container.controller = {};
    container.dispatchEvent(new Event('controllerchange'));
    expect(pwaUpdateNotice.value).toBeNull();
    expect(reload).not.toHaveBeenCalled();

    container.controller = {};
    container.dispatchEvent(new Event('controllerchange'));
    expect(pwaUpdateNotice.value).toBe('update');
    expect(reload).not.toHaveBeenCalled();
  });
});

// jsdom does not define crossOriginIsolated; provide a minimal mock.
Object.defineProperty(globalThis, 'crossOriginIsolated', { value: false, writable: true });

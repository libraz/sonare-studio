// jsdom does not define crossOriginIsolated; provide a minimal mock.
Object.defineProperty(globalThis, 'crossOriginIsolated', { value: false, writable: true });

// jsdom does not implement Element.prototype.scrollIntoView; components such as
// SelectMenu call it when an option becomes active. Provide a no-op so opening a
// menu in tests does not raise an unhandled rejection.
if (typeof Element !== 'undefined' && typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = () => {};
}

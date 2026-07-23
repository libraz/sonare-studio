import { config } from '@vue/test-utils';

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length(): number {
      return values.size;
    },
    clear(): void {
      values.clear();
    },
    getItem(key: string): string | null {
      return values.get(key) ?? null;
    },
    key(index: number): string | null {
      return [...values.keys()][index] ?? null;
    },
    removeItem(key: string): void {
      values.delete(key);
    },
    setItem(key: string, value: string): void {
      values.set(String(key), String(value));
    },
  };
}

// Node may expose an incomplete experimental localStorage before jsdom
// initializes. In that case jsdom preserves it, leaving browser-facing tests
// without the standard Storage methods.
if (typeof window.localStorage?.getItem !== 'function') {
  const storage = createMemoryStorage();
  Object.defineProperty(window, 'localStorage', { configurable: true, value: storage });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
}

// jsdom does not define crossOriginIsolated; provide a minimal mock.
Object.defineProperty(globalThis, 'crossOriginIsolated', { value: false, writable: true });

// Vue Test Utils stubs <TransitionGroup> by default, rendering a
// <transition-group-stub> wrapper instead of the real `tag` element. The list
// editors render their rows inside <TransitionGroup tag="tbody">, so the stub
// would drop the <tbody> that selectors and table semantics depend on. Render
// the real component (it is a no-op layout-wise in jsdom); <Transition> stays
// stubbed (its stub already passes children through).
config.global.stubs['transition-group'] = false;

// jsdom does not implement Element.prototype.scrollIntoView; components such as
// SelectMenu call it when an option becomes active. Provide a no-op so opening a
// menu in tests does not raise an unhandled rejection.
if (typeof Element !== 'undefined' && typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = () => {};
}

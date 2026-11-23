import { config } from '@vue/test-utils';
import { vRadioGroup } from '@/ui/accessibility/radiogroup';
import { vTabList } from '@/ui/accessibility/tablist';

// Segmented controls and tab strips get their keyboard behaviour from directives
// main.ts registers app-wide. Registering them here too lets a mounted component
// behave the way it does in the running app.
config.global.directives.radiogroup = vRadioGroup;
config.global.directives.tablist = vTabList;

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

// Default names read the UI language, as in the app. The UI modules load after
// the storage polyfill above, which the settings state reads on first import.
const [{ registerDefaultNames }, { uiDefaultNameSource }] = await Promise.all([
  import('@/project/default-names'),
  import('@/ui/i18n/default-name-source'),
]);
registerDefaultNames(uiDefaultNameSource());

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

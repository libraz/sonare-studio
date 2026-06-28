import { config } from '@vue/test-utils';

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

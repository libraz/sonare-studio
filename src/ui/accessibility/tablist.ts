import { createRovingDirective } from './roving';

/**
 * `v-tablist` — arrow-key navigation and roving tabindex for a container marked
 * `role="tablist"` whose children are `role="tab"` buttons.
 *
 * Tab strips share the radio group's keyboard contract: the strip is one tab
 * stop, and the arrows move between tabs. Selection follows focus, which is the
 * right choice here because every strip in this app switches an already-mounted
 * panel — there is nothing expensive to activate.
 *
 * Bind it on the strip root: `<div role="tablist" v-tablist>`. The tabs need no
 * changes beyond `role="tab"` and `aria-selected`.
 */
export const vTabList = createRovingDirective({
  role: 'tab',
  selectedAttribute: 'aria-selected',
});

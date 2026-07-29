import { createRovingDirective } from './roving';

/**
 * `v-radiogroup` — arrow-key navigation and roving tabindex for a container
 * marked `role="radiogroup"` whose children are `role="radio"` buttons.
 *
 * A segmented control is a radio group, and WAI-ARIA expects a radio group to
 * behave like one: Tab reaches the group once (landing on the checked option),
 * and the arrow keys move the selection between options. Without this a keyboard
 * user has to Tab through every segment, and a screen-reader user gets radios
 * that announce as radios but ignore the arrows.
 *
 * Bind it on the group root: `<div class="segmented" role="radiogroup"
 * v-radiogroup>`. The radios need no changes — the directive reads them from the
 * DOM, so a group whose options are rendered by `v-for` stays declarative.
 */
export const vRadioGroup = createRovingDirective({
  role: 'radio',
  selectedAttribute: 'aria-checked',
});

/**
 * Availability gates for controls that depend on other state.
 *
 * A control derives both `:disabled` and its tooltip reason from one value, so
 * the two never disagree: `const blocked = computed(() => firstBlock(...))`,
 * then `:disabled="!!blocked"` and `v-tooltip="{ text, reason: blocked }"`.
 * A dependent control lists its parent's gate first, so a cascade explains the
 * root cause rather than the nearest symptom.
 */

/** A prerequisite: when `blocked` is true, `reason` says what to do about it. */
export type Gate = readonly [blocked: boolean, reason: string];

/**
 * The reason of the first gate that blocks, or null when the control is usable.
 * Order gates from the most fundamental prerequisite to the most specific; a
 * bare string or null is an upstream control's own result, passed through.
 */
export function firstBlock(...gates: Array<Gate | string | null | undefined>): string | null {
  for (const gate of gates) {
    if (gate == null || gate === '') continue;
    if (typeof gate === 'string') return gate;
    if (gate[0]) return gate[1];
  }
  return null;
}

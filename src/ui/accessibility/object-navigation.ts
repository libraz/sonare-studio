/** Shared virtual-object model for keyboard and assistive-technology canvas access. */

export interface AccessibleObjectControl {
  /** Stable command key reported when the slider changes. */
  id: string;
  /** Accessible slider label. */
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  /** Optional musical rendering of the numeric value. */
  valueText?: string;
}

export interface AccessibleObjectItem {
  /** Stable id within the navigator. */
  id: string;
  /** Complete object description announced on navigation. */
  label: string;
  /** Whether the corresponding canvas object is selected. */
  selected: boolean;
  /** Editable numeric properties exposed with native slider semantics. */
  controls?: ReadonlyArray<AccessibleObjectControl>;
}

export type AccessibleObjectDirection = 'left' | 'right' | 'up' | 'down';

export interface AccessibleObjectAdjustment {
  id: string;
  direction: AccessibleObjectDirection;
  /** Shift+horizontal requests end/length adjustment instead of movement. */
  resize: boolean;
  /** Alt requests a larger application-defined increment. */
  coarse: boolean;
}

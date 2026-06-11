/**
 * Step sequencing for the welcome tour: a small state machine over an ordered
 * step list where each step anchors to a DOM element identified by a CSS
 * selector. Availability is re-checked on every move through an injected
 * predicate, so steps whose targets are missing (hidden panels, collapsed
 * zones) are skipped gracefully in both directions. No DOM access here; the
 * component supplies `document.querySelector`-backed availability.
 */

import type { TooltipSide } from './tour-placement';

/** One tour step, anchored to an element resolved by a CSS selector. */
export interface TourStep {
  /** Stable identifier, unique within the tour. */
  id: string;
  /** CSS selector of the anchor element; the step is skipped when no match. */
  target: string;
  /** Short heading shown in the tooltip. */
  title: string;
  /** One or two sentences of guidance. */
  body: string;
  /** Preferred tooltip side relative to the anchor (default 'bottom'). */
  placement?: TooltipSide;
}

/** Lifecycle of a {@link TourSequence}. */
export type TourStatus = 'idle' | 'active' | 'done';

/** How an ended tour ended (null while idle or active). */
export type TourOutcome = 'completed' | 'skipped' | null;

/** Position of the current step among the currently available steps. */
export interface TourProgress {
  /** 1-based index of the current step among available steps (0 when inactive). */
  index: number;
  /** Number of currently available steps. */
  count: number;
}

/**
 * Sequencer over a fixed step list with dynamic availability.
 *
 * `start` jumps to the first available step, `next`/`back` move across
 * available steps only, and reaching past the last available step completes
 * the tour. `skip` ends it early; the distinction is kept in `outcome`.
 */
export class TourSequence {
  private readonly steps: readonly TourStep[];
  private readonly isAvailable: (target: string) => boolean;
  private index = -1;
  private statusValue: TourStatus = 'idle';
  private outcomeValue: TourOutcome = null;

  constructor(steps: readonly TourStep[], isAvailable: (target: string) => boolean) {
    this.steps = steps;
    this.isAvailable = isAvailable;
  }

  /** Current lifecycle state. */
  get status(): TourStatus {
    return this.statusValue;
  }

  /** How the tour ended; null until `status` is 'done'. */
  get outcome(): TourOutcome {
    return this.outcomeValue;
  }

  /** The active step, or null when idle or done. */
  get current(): TourStep | null {
    return this.statusValue === 'active' ? this.steps[this.index] : null;
  }

  /** Whether a later available step exists. */
  get hasNext(): boolean {
    return this.statusValue === 'active' && this.findAvailable(this.index + 1, 1) !== -1;
  }

  /** Whether an earlier available step exists. */
  get hasBack(): boolean {
    return this.statusValue === 'active' && this.findAvailable(this.index - 1, -1) !== -1;
  }

  /** Position of the current step among the currently available steps. */
  get progress(): TourProgress {
    const available: number[] = [];
    for (let i = 0; i < this.steps.length; i += 1) {
      if (this.isAvailable(this.steps[i].target)) available.push(i);
    }
    if (this.statusValue !== 'active') return { index: 0, count: available.length };
    // The current step always counts, even if its target vanished after it
    // was entered (the tooltip stays up until the user moves on).
    if (!available.includes(this.index)) {
      available.push(this.index);
      available.sort((a, b) => a - b);
    }
    return { index: available.indexOf(this.index) + 1, count: available.length };
  }

  /**
   * Starts (or restarts) the tour at the first available step.
   *
   * @returns true when a step was entered; false when no step is available
   *   (the sequence stays idle).
   */
  start(): boolean {
    const first = this.findAvailable(0, 1);
    if (first === -1) {
      this.statusValue = 'idle';
      this.outcomeValue = null;
      this.index = -1;
      return false;
    }
    this.index = first;
    this.statusValue = 'active';
    this.outcomeValue = null;
    return true;
  }

  /** Moves to the next available step, completing the tour past the last one. */
  next(): void {
    if (this.statusValue !== 'active') return;
    const target = this.findAvailable(this.index + 1, 1);
    if (target === -1) {
      this.end('completed');
      return;
    }
    this.index = target;
  }

  /** Moves to the previous available step; no-op on the first one. */
  back(): void {
    if (this.statusValue !== 'active') return;
    const target = this.findAvailable(this.index - 1, -1);
    if (target !== -1) this.index = target;
  }

  /** Ends the tour early. */
  skip(): void {
    if (this.statusValue !== 'active') return;
    this.end('skipped');
  }

  private end(outcome: Exclude<TourOutcome, null>): void {
    this.statusValue = 'done';
    this.outcomeValue = outcome;
    this.index = -1;
  }

  /** First available step index scanning from `from` in `direction`, or -1. */
  private findAvailable(from: number, direction: 1 | -1): number {
    for (let i = from; i >= 0 && i < this.steps.length; i += direction) {
      if (this.isAvailable(this.steps[i].target)) return i;
    }
    return -1;
  }
}

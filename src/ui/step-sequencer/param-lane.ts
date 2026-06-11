/**
 * Value mapping for the per-step parameter lane (velocity / gate / offset
 * mini-bars). Kept pure so the bar geometry and drag math are testable
 * without a DOM.
 */

import {
  clampGate,
  clampOffset,
  clampVelocity,
  MAX_GATE,
  MIN_GATE,
  type PatternStep,
} from './pattern';

/** Editable per-step parameters. */
export type StepParamKind = 'velocity' | 'gate' | 'offset';

/** All parameter lane tabs, in display order. */
export const STEP_PARAM_KINDS: ReadonlyArray<StepParamKind> = ['velocity', 'gate', 'offset'];

/** True for parameters drawn around a center line (negative..positive). */
export function isBipolarParam(param: StepParamKind): boolean {
  return param === 'offset';
}

/**
 * Normalized display ratio (0..1, bottom..top of the lane) for a step's
 * current parameter value.
 */
export function paramRatio(param: StepParamKind, step: PatternStep): number {
  switch (param) {
    case 'velocity':
      return step.velocity / 127;
    case 'gate':
      return (step.gate - MIN_GATE) / (MAX_GATE - MIN_GATE);
    case 'offset':
      return step.offset + 0.5;
  }
}

/**
 * Inverse of {@link paramRatio}: converts a 0..1 lane position into a
 * clamped parameter value.
 */
export function paramValueForRatio(param: StepParamKind, ratio: number): number {
  const t = Math.min(1, Math.max(0, ratio));
  switch (param) {
    case 'velocity':
      return clampVelocity(t * 127);
    case 'gate':
      return clampGate(MIN_GATE + t * (MAX_GATE - MIN_GATE));
    case 'offset':
      return clampOffset(t - 0.5);
  }
}

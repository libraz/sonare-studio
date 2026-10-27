import { describe, expect, it } from 'vitest';
import { resolveAutomationId } from '@/engine/automation-ids';

/** The shape the wasm binding throws for a native failure. */
function sonareError(codeName: string): Error {
  return Object.assign(new Error(codeName), { code: 7, codeName });
}

describe('resolveAutomationId', () => {
  it('returns the resolved id', () => {
    expect(resolveAutomationId(() => 0)).toBe(0);
    expect(resolveAutomationId(() => 3758096385)).toBe(3758096385);
  });

  it('treats an unknown target or parameter as unresolved', () => {
    expect(
      resolveAutomationId(() => {
        throw new RangeError("paramName 'x' does not resolve to an automation id for this target");
      }),
    ).toBeUndefined();
  });

  it('treats a target earlier configuration has not created as unresolved', () => {
    expect(
      resolveAutomationId(() => {
        throw sonareError('InvalidState');
      }),
    ).toBeUndefined();
  });

  it('propagates any other failure', () => {
    expect(() =>
      resolveAutomationId(() => {
        throw sonareError('OutOfMemory');
      }),
    ).toThrow('OutOfMemory');
    expect(() =>
      resolveAutomationId(() => {
        throw new TypeError('bad');
      }),
    ).toThrow(TypeError);
  });
});

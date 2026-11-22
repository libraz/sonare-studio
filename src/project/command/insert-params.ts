import { type InsertParamValue, isInsertParamValue } from '../mixer';

/** Throws RangeError when an insert params record carries bad values. */
export function validateInsertParams(params: Record<string, InsertParamValue>): void {
  for (const [name, value] of Object.entries(params)) {
    if (name.length === 0) throw new RangeError('Insert param name must not be empty');
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new RangeError(`Insert param "${name}" must be finite, got ${value}`);
    }
    if (!isInsertParamValue(value)) {
      throw new RangeError(`Insert param "${name}" must be a number, boolean or choice name`);
    }
  }
}

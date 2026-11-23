import type { SoloProcessor } from '@libraz/libsonare';
import { type InsertParamValue, isInsertParamValue, isSoloProcessor } from '../mixer';
import { editedProcessorParams } from '../processor-controls';

/** Throws RangeError unless the engine knows the processor a slot would place. */
export function assertKnownProcessor(processor: string): asserts processor is SoloProcessor {
  if (!isSoloProcessor(processor)) throw new RangeError(`Unknown insert processor: ${processor}`);
}

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

/** Whether a param edit picks a new amp rig, which replaces every other param. */
function choosesAmpRig(processor: string, param: string): boolean {
  return processor === 'saturation.ampSim' && param === 'presetIndex';
}

/**
 * Whether a param edit changes the slot even when the edited value is unchanged:
 * picking an amp rig again still drops the custom knob settings over it.
 */
export function editDropsOtherParams(
  processor: string,
  params: Readonly<Record<string, InsertParamValue>>,
  param: string,
): boolean {
  return choosesAmpRig(processor, param) && Object.keys(params).some((name) => name !== param);
}

/**
 * The params a processor slot holds after one param edit, shared by track
 * inserts and the mastering chain. Choosing a new amp rig replaces the old
 * rig's custom knob settings: keeping them would make the newly selected preset
 * sound like a hybrid while the UI still names it as the untouched new rig.
 */
export function paramsAfterEdit(
  processor: string,
  params: Readonly<Record<string, InsertParamValue>>,
  param: string,
  value: InsertParamValue,
): Record<string, InsertParamValue> {
  return choosesAmpRig(processor, param)
    ? { [param]: value }
    : editedProcessorParams(processor, params, param, value);
}

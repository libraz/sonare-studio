import {
  cloneMasteringChain,
  createDefaultMasteringChain,
  type InsertSlot,
  isDefaultMasteringChain,
  type MasteringChainState,
  type ProjectMixerState,
} from '../mixer';
import { useProjectStore } from '../store';
import { type CommandGestureOptions, executeApp, hasPendingGesture } from './history';
import { validateInsertParams } from './insert-params';

/** Returns a working copy of the current mastering chain (default = empty). */
function currentMasteringChain(store: ReturnType<typeof useProjectStore>): MasteringChainState {
  return store.mixer.masteringChain
    ? cloneMasteringChain(store.mixer.masteringChain)
    : createDefaultMasteringChain();
}

/**
 * Writes a mastering chain back onto the project mixer state, dropping the
 * field entirely when the chain is empty so default projects serialize
 * without it.
 */
function writeMasteringChain(
  store: ReturnType<typeof useProjectStore>,
  chain: MasteringChainState,
): void {
  const next: ProjectMixerState = { ...store.mixer };
  if (isDefaultMasteringChain(chain)) delete next.masteringChain;
  else next.masteringChain = chain;
  store.mixer = next;
}

/** Returns the mastering processor slot at an index, or throws RangeError. */
function requireMasteringProcessor(chain: MasteringChainState, index: number): InsertSlot {
  if (!Number.isInteger(index) || index < 0 || index >= chain.processors.length) {
    throw new RangeError(`Unknown mastering processor index: ${index}`);
  }
  return chain.processors[index];
}

/**
 * Sets (or clears) the mastering preset as one undoable edit. The preset is a
 * wasm mastering preset name applied as a whole chain by the offline mixdown
 * renderer; live playback is unaffected.
 *
 * @param preset Preset name (non-empty), or null to clear.
 * @param options Gesture coalescing for preset-browsing UIs.
 */
export function setMasteringPreset(preset: string | null, options?: CommandGestureOptions): void {
  const store = useProjectStore();
  if (preset !== null && (typeof preset !== 'string' || preset.length === 0)) {
    throw new RangeError('Mastering preset name must not be empty');
  }
  const chain = currentMasteringChain(store);
  const key = 'mastering-preset';
  const current = chain.preset ?? null;
  if (current === preset && !hasPendingGesture(key)) return;
  executeApp(
    () => {
      if (preset === null) delete chain.preset;
      else chain.preset = preset;
      writeMasteringChain(store, chain);
      store.refresh();
    },
    { key, commit: options?.commit ?? true },
  );
}

/**
 * Appends a processor slot to the mastering chain as one undoable edit. The
 * processor is a wasm catalog name (masteringProcessorNames /
 * masteringInsertNames); it runs only in offline mixdown renders, after the
 * master strip (and after the preset, when one is set).
 *
 * @param processor Processor catalog name (non-empty).
 * @param params Initial parameter overrides (camelCase keys).
 * @returns The index of the new slot.
 */
export function addMasteringProcessor(
  processor: string,
  params: Record<string, number | boolean> = {},
): number {
  const store = useProjectStore();
  if (typeof processor !== 'string' || processor.length === 0) {
    throw new RangeError('Mastering processor name must not be empty');
  }
  validateInsertParams(params);
  const chain = currentMasteringChain(store);
  return executeApp(() => {
    chain.processors = [...chain.processors, { processor, params: { ...params }, enabled: true }];
    writeMasteringChain(store, chain);
    store.refresh();
    return chain.processors.length - 1;
  });
}

/**
 * Removes a mastering processor slot as one undoable edit.
 *
 * @param index Slot index (later slots shift down).
 */
export function removeMasteringProcessor(index: number): void {
  const store = useProjectStore();
  const chain = currentMasteringChain(store);
  requireMasteringProcessor(chain, index);
  executeApp(() => {
    chain.processors = chain.processors.filter((_, i) => i !== index);
    writeMasteringChain(store, chain);
    store.refresh();
  });
}

/**
 * Enables or bypasses a mastering processor slot as one undoable edit.
 *
 * @param index Slot index.
 * @param enabled New enabled state.
 */
export function setMasteringEnabled(index: number, enabled: boolean): void {
  const store = useProjectStore();
  const chain = currentMasteringChain(store);
  const slot = requireMasteringProcessor(chain, index);
  if (slot.enabled === enabled) return;
  executeApp(() => {
    chain.processors[index] = { ...chain.processors[index], enabled };
    writeMasteringChain(store, chain);
    store.refresh();
  });
}

/**
 * Sets one parameter of a mastering processor slot as one undoable edit.
 *
 * @param index Slot index.
 * @param param Parameter name (camelCase, see masteringInsertParamNames).
 * @param value New value (finite number or boolean).
 * @param options Gesture coalescing for knob drags.
 */
export function setMasteringParam(
  index: number,
  param: string,
  value: number | boolean,
  options?: CommandGestureOptions,
): void {
  const store = useProjectStore();
  const chain = currentMasteringChain(store);
  const slot = requireMasteringProcessor(chain, index);
  if (param.length === 0) throw new RangeError('Mastering param name must not be empty');
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new RangeError(`Mastering param "${param}" must be finite, got ${value}`);
  }
  const key = `mastering-param:${index}:${param}`;
  if (slot.params[param] === value && !hasPendingGesture(key)) return;
  executeApp(
    () => {
      chain.processors[index] = {
        ...chain.processors[index],
        params: { ...chain.processors[index].params, [param]: value },
      };
      writeMasteringChain(store, chain);
      store.refresh();
    },
    { key, commit: options?.commit ?? true },
  );
}

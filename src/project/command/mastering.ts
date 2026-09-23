import {
  cloneMasteringChain,
  createDefaultMasteringChain,
  createProcessorId,
  type InsertSlot,
  isDefaultMasteringChain,
  type MasteringChainState,
  type ProjectMixerState,
} from '../mixer';
import { useProjectStore } from '../store';
import {
  pruneMasteringProcessorReferences,
  reorderMasteringProcessorReferences,
} from '../target-reference-registry';
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
 * renderer; live playback mirrors only explicit realtime-safe processor slots.
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
      if (preset === null) {
        delete chain.preset;
        delete chain.presetOverrides;
      } else {
        chain.preset = preset;
      }
      writeMasteringChain(store, chain);
      store.refresh();
    },
    { key, commit: options?.commit ?? true },
  );
}

/**
 * Selects a mastering preset together with the overrides that tune it, as one
 * undoable edit: an assistant suggestion is the preset plus its departures, and
 * undoing it must restore both. The overrides replace any the chain had.
 *
 * @param preset Wasm mastering preset name.
 * @param overrides Flat override map; empty clears the chain's overrides.
 */
export function applyMasteringPresetWithOverrides(
  preset: string,
  overrides: Readonly<Record<string, number | boolean>>,
): void {
  const store = useProjectStore();
  if (preset.length === 0) throw new RangeError('Mastering preset name must not be empty');
  for (const [param, value] of Object.entries(overrides)) {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new RangeError(`Mastering preset override "${param}" must be finite, got ${value}`);
    }
  }
  const chain = currentMasteringChain(store);
  executeApp(() => {
    chain.preset = preset;
    if (Object.keys(overrides).length === 0) delete chain.presetOverrides;
    else chain.presetOverrides = { ...overrides };
    writeMasteringChain(store, chain);
    store.refresh();
  });
}

/**
 * Sets or clears a flat override for the selected mastering preset. Overrides
 * are applied by masterAudioStereo on top of the named preset during export.
 *
 * @param param Dot-notation override key (for example 'loudness.targetLufs').
 * @param value Finite number/boolean to set, or null to clear.
 * @param options Gesture coalescing for slider drags.
 */
export function setMasteringPresetOverride(
  param: string,
  value: number | boolean | null,
  options?: CommandGestureOptions,
): void {
  const store = useProjectStore();
  if (param.length === 0) throw new RangeError('Mastering preset override name must not be empty');
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new RangeError(`Mastering preset override "${param}" must be finite, got ${value}`);
  }
  const chain = currentMasteringChain(store);
  if (chain.preset === undefined) {
    throw new RangeError('Mastering preset overrides require a selected preset');
  }
  const overrides = chain.presetOverrides ?? {};
  const key = `mastering-preset-override:${param}`;
  if ((overrides[param] ?? null) === value && !hasPendingGesture(key)) return;
  executeApp(
    () => {
      const nextOverrides = { ...overrides };
      if (value === null) delete nextOverrides[param];
      else nextOverrides[param] = value;
      if (Object.keys(nextOverrides).length === 0) delete chain.presetOverrides;
      else chain.presetOverrides = nextOverrides;
      writeMasteringChain(store, chain);
      store.refresh();
    },
    { key, commit: options?.commit ?? true },
  );
}

/**
 * Appends a processor slot to the mastering chain as one undoable edit. The
 * processor is a wasm catalog name (masteringProcessorNames /
 * masteringInsertNames); export runs the full slot after the master strip
 * (and after the preset, when one is set), while live playback mirrors the
 * slot only when it is valid as a realtime strip insert.
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
    chain.processors = [
      ...chain.processors,
      { id: createProcessorId(), processor, params: { ...params }, enabled: true },
    ];
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
  const removed = requireMasteringProcessor(chain, index);
  executeApp(() => {
    chain.processors = chain.processors.filter((_, i) => i !== index);
    writeMasteringChain(store, chain);
    pruneMasteringProcessorReferences(store, index, removed.id);
    store.refresh();
  });
}

/**
 * Moves a mastering processor from one slot index to another as one undoable
 * edit. Reordering through the per-slot add/remove primitives would record a
 * separate undo step for each primitive (and momentarily drop and re-create
 * slots); this performs the whole move atomically, preserving each slot's
 * params and enabled state.
 *
 * @param from Index of the slot to move.
 * @param to Destination index after the move (slots in between shift to fill).
 */
export function reorderMasteringProcessor(from: number, to: number): void {
  const store = useProjectStore();
  const chain = currentMasteringChain(store);
  requireMasteringProcessor(chain, from);
  requireMasteringProcessor(chain, to);
  if (from === to) return;
  executeApp(() => {
    const processors = [...chain.processors];
    const [moved] = processors.splice(from, 1);
    processors.splice(to, 0, moved);
    chain.processors = processors;
    writeMasteringChain(store, chain);
    reorderMasteringProcessorReferences(store, from, to);
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

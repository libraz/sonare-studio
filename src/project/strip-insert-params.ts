import type { MasteringInsertName } from '@libraz/libsonare';
import { upgradeDetectorDelayParamName } from './document-schema-v5';
import type { WasmModule } from './runtime';

type JsonObject = Record<string, unknown>;
type InsertCatalog = Pick<WasmModule, 'masteringInsertNames' | 'masteringInsertTiming'>;
type MasteringTimingParams = NonNullable<
  Parameters<WasmModule['masteringInsertTiming']>[0]['params']
>;

export interface InsertParamValidationOptions {
  sampleRate?: number;
  collectionKey?: string;
  indexOffset?: number;
}

export interface ProjectInsertNormalizationOptions {
  sampleRate?: number;
}

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const processorNameCache = new WeakMap<object, ReadonlyArray<MasteringInsertName>>();

function catalogNames(wasm: InsertCatalog): ReadonlyArray<MasteringInsertName> {
  let names = processorNameCache.get(wasm);
  if (!names) {
    names = wasm.masteringInsertNames();
    processorNameCache.set(wasm, names);
  }
  return names;
}

function timingParams(value: unknown): value is MasteringTimingParams {
  return (
    isObject(value) &&
    Object.values(value).every(
      (param) =>
        typeof param === 'number' ||
        typeof param === 'boolean' ||
        typeof param === 'string' ||
        (Array.isArray(param) && param.every((item) => typeof item === 'number')),
    )
  );
}

/**
 * Preserves the legacy detector-delay key and delegates insert admission to
 * the runtime timing query at load and command boundaries.
 */
export function normalizeStripInsertParams<T extends JsonObject>(
  strip: T,
  wasm: InsertCatalog,
  path: string,
  options: InsertParamValidationOptions = {},
): T {
  const { sampleRate = 48000, collectionKey = 'inserts', indexOffset = 0 } = options;
  if (!Object.hasOwn(strip, collectionKey)) return strip;
  if (!Array.isArray(strip[collectionKey])) {
    throw new TypeError(`${path}.${collectionKey} must be an array`);
  }
  const processors = catalogNames(wasm);
  let changed = false;
  const inserts = (strip[collectionKey] as unknown[]).map((value, index) => {
    const insertPath = `${path}.${collectionKey}[${index + indexOffset}]`;
    if (!isObject(value)) {
      throw new TypeError(`${insertPath} must be an object`);
    }
    if (typeof value.processor !== 'string' || value.processor.length === 0) {
      throw new TypeError(`${insertPath}.processor must be a non-empty string`);
    }
    const processor = processors.find((name) => name === value.processor);
    if (!processor) {
      throw new RangeError(`${insertPath}.processor must be a supported insert name`);
    }
    if (!isObject(value.params)) {
      throw new TypeError(`${insertPath}.params must be an object`);
    }

    let params: JsonObject = value.params;
    for (const key of Object.keys(params)) {
      const currentName = upgradeDetectorDelayParamName(processor, key);
      if (currentName !== key) {
        if (params === value.params) params = { ...value.params };
        if (!Object.hasOwn(params, currentName)) params[currentName] = params[key];
        delete params[key];
      }
    }
    if (!timingParams(params)) {
      throw new TypeError(`${insertPath}.params contains a value with an unsupported shape`);
    }

    try {
      wasm.masteringInsertTiming({ insert: processor, params, sampleRate });
    } catch (error) {
      if (error instanceof TypeError) throw new TypeError(`${insertPath}: ${error.message}`);
      if (error instanceof RangeError) throw new RangeError(`${insertPath}: ${error.message}`);
      throw error;
    }

    if (params === value.params) return value;
    changed = true;
    return { ...value, params };
  });
  return changed ? ({ ...strip, [collectionKey]: inserts } as T) : strip;
}

/**
 * Walks every persisted insert-bearing mixer surface before the Project
 * mirror or an offline render is built.
 */
export function normalizeProjectInsertParams<T extends object>(
  document: T,
  wasm: InsertCatalog,
  options: ProjectInsertNormalizationOptions = {},
): T {
  const { sampleRate = 48000 } = options;
  const normalizeMixer = (mixerValue: unknown, path: string): unknown => {
    if (!isObject(mixerValue)) return mixerValue;
    const mixer = { ...mixerValue };
    if (isObject(mixer.master)) {
      mixer.master = normalizeStripInsertParams(mixer.master, wasm, `${path}.master`, {
        sampleRate,
      });
    }
    if (Array.isArray(mixer.buses)) {
      mixer.buses = mixer.buses.map((bus, index) => {
        if (!isObject(bus) || !isObject(bus.strip)) return bus;
        return {
          ...bus,
          strip: normalizeStripInsertParams(bus.strip, wasm, `${path}.buses[${index}].strip`, {
            sampleRate,
          }),
        };
      });
    }
    if (isObject(mixer.masteringChain) && Array.isArray(mixer.masteringChain.processors)) {
      const chain = { ...mixer.masteringChain };
      const processors = catalogNames(wasm);
      chain.processors = mixer.masteringChain.processors.map((slot, index) => {
        if (!isObject(slot) || typeof slot.processor !== 'string') return slot;
        if (!processors.some((name) => name === slot.processor)) return slot;
        const normalized = normalizeStripInsertParams(
          { processors: [slot] },
          wasm,
          `${path}.masteringChain`,
          {
            sampleRate,
            collectionKey: 'processors',
            indexOffset: index,
          },
        ).processors;
        return normalized[0] ?? slot;
      });
      mixer.masteringChain = chain;
    }
    return mixer;
  };

  const next: JsonObject = { ...(document as JsonObject) };
  if (Array.isArray(next.tracks)) {
    next.tracks = next.tracks.map((track, index) => {
      if (!isObject(track) || !isObject(track.mixer)) return track;
      return {
        ...track,
        mixer: normalizeStripInsertParams(track.mixer, wasm, `tracks[${index}].mixer`, {
          sampleRate,
        }),
      };
    });
  }
  if (next.mixer !== undefined) next.mixer = normalizeMixer(next.mixer, 'mixer');

  const snapshots = next.mixerSnapshots;
  if (isObject(snapshots) && isObject(snapshots.slots)) {
    const slots = { ...snapshots.slots };
    for (const [key, snapshotValue] of Object.entries(slots)) {
      if (!isObject(snapshotValue)) continue;
      const snapshot = { ...snapshotValue };
      if (snapshot.mixer !== undefined) {
        snapshot.mixer = normalizeMixer(snapshot.mixer, `mixerSnapshots.slots.${key}.mixer`);
      }
      if (Array.isArray(snapshot.tracks)) {
        snapshot.tracks = snapshot.tracks.map((track, index) => {
          if (!isObject(track) || !isObject(track.mixer)) return track;
          return {
            ...track,
            mixer: normalizeStripInsertParams(
              track.mixer,
              wasm,
              `mixerSnapshots.slots.${key}.tracks[${index}].mixer`,
              { sampleRate },
            ),
          };
        });
      }
      slots[key] = snapshot;
    }
    next.mixerSnapshots = { ...snapshots, slots };
  }
  return next as T;
}

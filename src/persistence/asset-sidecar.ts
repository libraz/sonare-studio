/** Codec for the asset metadata sidecar: schema v2 records, legacy v1 sidecars and tags. */

import { isFiniteNumber } from '@/lib/math';
import { InvalidAssetError } from './asset-errors';
import type { AudioAssetAlias, AudioAssetMeta, AudioAssetTags } from './assets';
import { MAX_AUDIO_CHANNELS, MAX_AUDIO_SAMPLE_RATE, MAX_AUDIO_SAMPLES } from './resource-limits';

interface StoredAudioAssetRecord {
  schemaVersion: 2;
  content: {
    id: string;
    sampleRate: number;
    numChannels: number;
    numFrames: number;
  };
  aliases: AudioAssetAlias[];
}

const NUMERIC_TAG_KEYS = [
  'bpm',
  'bpmConfidence',
  'keyConfidence',
  'timeSignatureConfidence',
  'syncopation',
  'patternRegularity',
  'tempoStability',
  'dynamicRangeDb',
  'peakDb',
  'rmsDb',
  'crestFactor',
  'loudnessRangeDb',
  'brightness',
  'warmth',
  'density',
  'roughness',
  'complexity',
  'lufs',
] as const satisfies ReadonlyArray<keyof AudioAssetTags>;

const STRING_TAG_KEYS = [
  'key',
  'timeSignature',
  'grooveType',
  'form',
] as const satisfies ReadonlyArray<keyof AudioAssetTags>;

export function sanitizeAudioAssetTags(
  raw: AudioAssetTags | undefined,
): AudioAssetTags | undefined {
  if (!raw) return undefined;
  const tags: AudioAssetTags = {};
  for (const key of NUMERIC_TAG_KEYS) {
    const value = raw[key];
    if (isFiniteNumber(value)) {
      if (key !== 'bpm' || value > 0) tags[key] = value;
    }
  }
  for (const key of STRING_TAG_KEYS) {
    const value = raw[key];
    if (typeof value === 'string' && value.length > 0) tags[key] = value;
  }
  if (typeof raw.isCompressed === 'boolean') tags.isCompressed = raw.isCompressed;
  return Object.keys(tags).length > 0 ? tags : undefined;
}

export function validatedContentMeta(
  value: Partial<AudioAssetMeta>,
  id: string,
  alias: AudioAssetAlias,
): AudioAssetMeta {
  if (
    value.id !== id ||
    typeof value.sampleRate !== 'number' ||
    !Number.isFinite(value.sampleRate) ||
    value.sampleRate <= 0 ||
    value.sampleRate > MAX_AUDIO_SAMPLE_RATE ||
    !Number.isInteger(value.numChannels) ||
    (value.numChannels as number) < 1 ||
    (value.numChannels as number) > MAX_AUDIO_CHANNELS ||
    !Number.isInteger(value.numFrames) ||
    (value.numFrames as number) < 1 ||
    !Number.isSafeInteger((value.numFrames as number) * (value.numChannels as number)) ||
    (value.numFrames as number) * (value.numChannels as number) > MAX_AUDIO_SAMPLES
  ) {
    throw new InvalidAssetError(`Asset "${id}": malformed metadata sidecar`);
  }
  return {
    id,
    name: alias.name,
    sampleRate: value.sampleRate,
    numChannels: value.numChannels as number,
    numFrames: value.numFrames as number,
    ...(alias.tags ? { tags: { ...alias.tags } } : {}),
  };
}

function validateAlias(value: unknown, id: string): AudioAssetAlias {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InvalidAssetError(`Asset "${id}": malformed metadata alias`);
  }
  const raw = value as Partial<AudioAssetAlias>;
  if (typeof raw.name !== 'string' || raw.name.length === 0) {
    throw new InvalidAssetError(`Asset "${id}": malformed metadata alias`);
  }
  const tags =
    typeof raw.tags === 'object' && raw.tags !== null
      ? sanitizeAudioAssetTags(raw.tags as AudioAssetTags)
      : undefined;
  return { name: raw.name, ...(tags ? { tags } : {}) };
}

export function recordFromMeta(
  meta: AudioAssetMeta,
  aliases: AudioAssetAlias[],
): StoredAudioAssetRecord {
  return {
    schemaVersion: 2,
    content: {
      id: meta.id,
      sampleRate: meta.sampleRate,
      numChannels: meta.numChannels,
      numFrames: meta.numFrames,
    },
    aliases: aliases.map((alias) => ({
      name: alias.name,
      ...(alias.tags ? { tags: { ...alias.tags } } : {}),
    })),
  };
}

export function decodeStoredRecord(
  value: unknown,
  id: string,
): { meta: AudioAssetMeta; aliases: AudioAssetAlias[]; record: StoredAudioAssetRecord } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InvalidAssetError(`Asset "${id}": metadata sidecar is not a JSON object`);
  }
  const raw = value as Partial<StoredAudioAssetRecord> & Partial<AudioAssetMeta>;
  if (raw.schemaVersion === 2) {
    if (
      typeof raw.content !== 'object' ||
      raw.content === null ||
      !Array.isArray(raw.aliases) ||
      raw.aliases.length === 0
    ) {
      throw new InvalidAssetError(`Asset "${id}": malformed metadata sidecar`);
    }
    const aliases = raw.aliases.map((alias) => validateAlias(alias, id));
    const meta = validatedContentMeta(
      raw.content as Partial<AudioAssetMeta>,
      id,
      aliases[aliases.length - 1],
    );
    return { meta, aliases, record: recordFromMeta(meta, aliases) };
  }
  // Legacy v1 sidecars stored the mutable display metadata beside content.
  if (typeof raw.name !== 'string' || raw.name.length === 0) {
    throw new InvalidAssetError(`Asset "${id}": malformed metadata sidecar`);
  }
  const alias = validateAlias({ name: raw.name, tags: raw.tags }, id);
  const meta = validatedContentMeta(raw, id, alias);
  return { meta, aliases: [alias], record: recordFromMeta(meta, [alias]) };
}

/** Validates a parsed sidecar object into an {@link AudioAssetMeta}. */
export function validateMeta(value: unknown, id: string): AudioAssetMeta {
  return decodeStoredRecord(value, id).meta;
}

export function aliasesEqual(a: AudioAssetAlias, b: AudioAssetAlias): boolean {
  return a.name === b.name && JSON.stringify(a.tags ?? {}) === JSON.stringify(b.tags ?? {});
}

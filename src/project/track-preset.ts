/**
 * Portable per-track channel settings.
 *
 * Unlike a mixer snapshot, a track preset deliberately has no project identity:
 * it can be saved once and applied in another song.  Routing ids are kept in
 * the payload for same-project copy/paste and sanitized by the apply command
 * when the destination project does not contain them.
 */

import { upgradeTrackPresetToV2 } from './document-schema-v5';
import {
  cloneInstrument,
  loadInstrument,
  type TrackInstrument,
  validateTrackInstrument,
} from './instrument';
import { isMidiFxNoop, type MidiFxConfig, sanitizeMidiFxConfig } from './midi-fx';
import { cloneStrip, createDefaultStrip, isMixerGainDb, type MixerStrip } from './mixer';
import { currentProject, DEFAULT_SAMPLE_RATE, getWasmModule } from './runtime';
import { normalizeStripInsertParams } from './strip-insert-params';
import type { EditorTrack } from './types';

/**
 * Current on-disk shape of a saved track/channel preset. Version 2 stores the
 * libsonare 2.0 vocabulary; version-1 presets are upgraded on read.
 */
export const TRACK_CHANNEL_PRESET_SCHEMA_VERSION = 2;

/** A reusable track instrument, MIDI-FX and mixer-strip configuration. */
export interface TrackChannelPreset {
  schemaVersion: typeof TRACK_CHANNEL_PRESET_SCHEMA_VERSION;
  /** User-facing preset name. */
  name: string;
  /** Complete channel-strip state, including inserts, EQ, sends and routing. */
  strip: MixerStrip;
  /** MIDI instrument; null means restore the default instrument. */
  instrument?: TrackInstrument | null;
  /** Live MIDI-FX; absent means clear MIDI-FX on application. */
  midiFx?: MidiFxConfig;
}

/** Maximum friendly preset name length, keeping OPFS entries and menus practical. */
export const TRACK_CHANNEL_PRESET_NAME_MAX_LENGTH = 80;

/** Creates a detached portable preset from one track's current channel state. */
export function trackChannelPresetFromTrack(track: EditorTrack, name: string): TrackChannelPreset {
  const preset: TrackChannelPreset = {
    schemaVersion: TRACK_CHANNEL_PRESET_SCHEMA_VERSION,
    name: normalizeTrackChannelPresetName(name),
    strip: cloneStrip(track.mixer ?? createDefaultStrip()),
  };
  if (track.kind === 'midi') {
    preset.instrument = track.instrument ? cloneInstrument(track.instrument) : null;
    if (track.midiFx !== undefined) {
      const midiFx = sanitizeMidiFxConfig(track.midiFx);
      if (!isMidiFxNoop(midiFx)) preset.midiFx = midiFx;
    }
  }
  return preset;
}

/** Validates and normalizes a name used in a user-visible preset menu. */
export function normalizeTrackChannelPresetName(name: string): string {
  const normalized = name.trim();
  if (normalized.length === 0) throw new RangeError('Track preset name must not be empty');
  if (normalized.length > TRACK_CHANNEL_PRESET_NAME_MAX_LENGTH) {
    throw new RangeError(
      `Track preset name must be at most ${TRACK_CHANNEL_PRESET_NAME_MAX_LENGTH} characters`,
    );
  }
  return normalized;
}

/** Decodes one stored preset, rejecting malformed or stale data before it reaches the store. */
export function normalizeTrackChannelPreset(value: unknown): TrackChannelPreset {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RangeError('Track preset must be an object');
  }
  const stored = value as Record<string, unknown>;
  const raw = stored.schemaVersion === 1 ? upgradeTrackPresetToV2(stored, getWasmModule()) : stored;
  if (raw.schemaVersion !== TRACK_CHANNEL_PRESET_SCHEMA_VERSION) {
    throw new RangeError('Unsupported track preset schema version');
  }
  if (typeof raw.name !== 'string') throw new RangeError('Track preset name must be a string');
  if (!raw.strip || typeof raw.strip !== 'object' || Array.isArray(raw.strip)) {
    throw new RangeError('Track preset strip must be an object');
  }

  // Check the raw values before cloning so an invalid number keeps its error classification.
  const storedStrip = raw.strip as MixerStrip;
  const normalizedStrip =
    Array.isArray(storedStrip.inserts) && storedStrip.inserts.length > 0
      ? normalizeStripInsertParams({ ...storedStrip }, getWasmModule(), 'strip', {
          sampleRate: currentProject()?.sampleRate ?? DEFAULT_SAMPLE_RATE,
        })
      : storedStrip;
  const strip = cloneStrip(normalizedStrip);
  if (
    !isMixerGainDb(strip.gainDb) ||
    !Number.isFinite(strip.pan) ||
    strip.pan < -1 ||
    strip.pan > 1
  ) {
    throw new RangeError('Track preset strip contains an invalid gain or pan');
  }
  if (!Array.isArray(strip.inserts) || !Array.isArray(strip.sends)) {
    throw new RangeError('Track preset strip must contain inserts and sends arrays');
  }
  strip.inserts.forEach((insert, index) => {
    if (typeof insert.enabled !== 'boolean') {
      throw new TypeError(`strip.inserts[${index}].enabled must be a boolean`);
    }
  });
  for (const send of strip.sends) {
    if (
      !send ||
      typeof send.busId !== 'string' ||
      send.busId.length === 0 ||
      !isMixerGainDb(send.levelDb) ||
      typeof send.enabled !== 'boolean' ||
      (send.timing !== undefined && send.timing !== 'preFader' && send.timing !== 'postFader')
    ) {
      throw new RangeError('Track preset contains an invalid send');
    }
  }

  const preset: TrackChannelPreset = {
    schemaVersion: TRACK_CHANNEL_PRESET_SCHEMA_VERSION,
    name: normalizeTrackChannelPresetName(raw.name),
    strip,
  };
  if (raw.instrument === null) preset.instrument = null;
  else if (raw.instrument !== undefined) {
    validateTrackInstrument(raw.instrument as TrackInstrument);
    preset.instrument = loadInstrument(raw.instrument as TrackInstrument);
  }
  if (raw.midiFx && typeof raw.midiFx === 'object' && !Array.isArray(raw.midiFx)) {
    const midiFx = sanitizeMidiFxConfig(raw.midiFx as Partial<MidiFxConfig>);
    if (!isMidiFxNoop(midiFx)) preset.midiFx = midiFx;
  } else if (raw.midiFx !== undefined) {
    throw new RangeError('Track preset MIDI-FX must be an object');
  }
  return preset;
}

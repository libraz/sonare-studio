/**
 * Portable per-track channel settings.
 *
 * Unlike a mixer snapshot, a track preset deliberately has no project identity:
 * it can be saved once and applied in another song.  Routing ids are kept in
 * the payload for same-project copy/paste and sanitized by the apply command
 * when the destination project does not contain them.
 */

import { cloneInstrument, type TrackInstrument, validateTrackInstrument } from './instrument';
import { isMidiFxNoop, type MidiFxConfig, sanitizeMidiFxConfig } from './midi-fx';
import {
  cloneStrip,
  createDefaultStrip,
  MAX_STRIP_GAIN_DB,
  MIN_STRIP_GAIN_DB,
  type MixerStrip,
} from './mixer';
import type { EditorTrack } from './types';

/** Current on-disk shape of a saved track/channel preset. */
export const TRACK_CHANNEL_PRESET_SCHEMA_VERSION = 1;

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
  const raw = value as Record<string, unknown>;
  if (raw.schemaVersion !== TRACK_CHANNEL_PRESET_SCHEMA_VERSION) {
    throw new RangeError('Unsupported track preset schema version');
  }
  if (typeof raw.name !== 'string') throw new RangeError('Track preset name must be a string');
  if (!raw.strip || typeof raw.strip !== 'object' || Array.isArray(raw.strip)) {
    throw new RangeError('Track preset strip must be an object');
  }

  // The strip and instruments are JSON-only structures.  Clone first so no
  // caller can retain mutable references into a saved preset.
  const strip = cloneStrip(raw.strip as MixerStrip);
  if (
    !Number.isFinite(strip.gainDb) ||
    strip.gainDb < MIN_STRIP_GAIN_DB ||
    strip.gainDb > MAX_STRIP_GAIN_DB ||
    !Number.isFinite(strip.pan) ||
    strip.pan < -1 ||
    strip.pan > 1
  ) {
    throw new RangeError('Track preset strip contains an invalid gain or pan');
  }
  if (!Array.isArray(strip.inserts) || !Array.isArray(strip.sends)) {
    throw new RangeError('Track preset strip must contain inserts and sends arrays');
  }
  for (const insert of strip.inserts) {
    if (
      !insert ||
      typeof insert.processor !== 'string' ||
      insert.processor.length === 0 ||
      !insert.params ||
      typeof insert.params !== 'object' ||
      Array.isArray(insert.params) ||
      typeof insert.enabled !== 'boolean'
    ) {
      throw new RangeError('Track preset contains an invalid insert');
    }
    for (const [key, param] of Object.entries(insert.params)) {
      if (
        key.length === 0 ||
        (typeof param !== 'boolean' && (typeof param !== 'number' || !Number.isFinite(param)))
      ) {
        throw new RangeError('Track preset contains invalid insert parameters');
      }
    }
  }
  for (const send of strip.sends) {
    if (
      !send ||
      typeof send.busId !== 'string' ||
      send.busId.length === 0 ||
      !Number.isFinite(send.levelDb) ||
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
    preset.instrument = cloneInstrument(raw.instrument as TrackInstrument);
  }
  if (raw.midiFx && typeof raw.midiFx === 'object' && !Array.isArray(raw.midiFx)) {
    const midiFx = sanitizeMidiFxConfig(raw.midiFx as Partial<MidiFxConfig>);
    if (!isMidiFxNoop(midiFx)) preset.midiFx = midiFx;
  } else if (raw.midiFx !== undefined) {
    throw new RangeError('Track preset MIDI-FX must be an object');
  }
  return preset;
}

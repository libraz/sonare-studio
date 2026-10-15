/**
 * Offline MIDI prerender helpers: bounce a MIDI phrase to audio buffers with
 * a libsonare instrument, cache the renders, and normalize levels. These serve
 * UI audition (src/ui/devices/audition.ts) and note preview
 * (src/composables/useNotePreview.ts). Neither realtime playback nor the
 * offline export renderer (src/export/engine-render.ts) prerenders — MIDI
 * clips and instruments are engine state fed by the engine's MIDI scheduling
 * (src/engine/midi-sync.ts).
 */

import { ensureWasm } from '@/lib/wasm';
import { loadFont as loadStoredFont } from '@/project/fonts';
import {
  DEFAULT_SYNTH_PRESET,
  instrumentCacheSegment,
  type SynthPresetInstrument,
  sf2ChannelProgram,
  sf2PlaybackConfig,
  type TrackInstrument,
} from '@/project/instrument';
import { DEFAULT_TEMPO_BPM } from '@/project/tempo-map';
import type { ProjectMidiEvent } from '@/wasm/index.js';

/** One note of a MIDI phrase, positioned in quarter-note pulses (PPQ). */
export interface MidiNote {
  /** MIDI note number (integer, 0-127). */
  note: number;
  /** Note-on velocity (integer, 1-127). */
  velocity: number;
  /** Optional note-off/release velocity (integer, 0-127); omitted = 0. */
  offVelocity?: number;
  /** Note start within the clip, in PPQ (fractional allowed, >= 0). */
  startPpq: number;
  /** Note length in PPQ (> 0). */
  durationPpq: number;
  /** MIDI channel (integer, 0-15). Defaults to 0. */
  channel?: number;
}

/** Options controlling an offline MIDI clip render. */
export interface PrerenderMidiClipOptions {
  /** Output sample rate in Hz; pass the engine AudioContext sample rate. */
  sampleRate: number;
  /** Constant tempo in BPM used for the bounce (default 120). */
  tempoBpm?: number;
  /** NativeSynth preset name rendered via bounceWithSynthInstrument (default {@link DEFAULT_SYNTH_PRESET}). */
  preset?: string;
  /**
   * Full instrument descriptor (preset, editable synth patch, or SoundFont).
   * Takes precedence over `preset`, which remains as the simple form.
   */
  instrument?: TrackInstrument;
  /**
   * SoundFont loader for 'sf2' instruments; defaults to the OPFS font store
   * (src/project/fonts.ts). Injectable for tests.
   */
  loadFont?: (fontId: string) => Promise<Uint8Array>;
}

/** Gain ceiling for normalization, so a near-silent render is not blown up. */
const MAX_NORMALIZE_GAIN = 24;

/**
 * Returns the maximum absolute sample value across all channels.
 *
 * @param channels Planar audio buffers.
 * @returns Peak amplitude (0 for empty buffers).
 */
export function peakAmplitude(channels: ReadonlyArray<Float32Array>): number {
  let peak = 0;
  for (const channel of channels) {
    for (const sample of channel) {
      const a = Math.abs(sample);
      if (a > peak) peak = a;
    }
  }
  return peak;
}

/**
 * Computes the clip gain that normalizes a rendered peak to a target peak.
 *
 * @param peak Measured peak amplitude of the render.
 * @param targetPeak Desired peak after the engine applies the clip gain.
 * @returns A gain in (0, MAX_NORMALIZE_GAIN]; 1 when the peak is unusable.
 */
export function normalizeGain(peak: number, targetPeak: number): number {
  if (!Number.isFinite(peak) || peak <= 0 || !Number.isFinite(targetPeak) || targetPeak <= 0) {
    return 1;
  }
  return Math.min(targetPeak / peak, MAX_NORMALIZE_GAIN);
}

/** A note-on or note-off boundary derived from a {@link MidiNote} list. */
export interface NoteEvent {
  /** Event position in PPQ. */
  ppq: number;
  /** 'off' events sort before 'on' events at the same PPQ to avoid retrigger glitches. */
  kind: 'off' | 'on';
  /** MIDI note number (0-127). */
  note: number;
  /** Velocity (note-on velocity for 'on', release velocity for 'off'). */
  velocity: number;
  /** MIDI channel (0-15). */
  channel: number;
}

const CACHE_KEY_VERSION = 'v1';
/** Maximum distinct offline MIDI prerenders retained in memory. */
export const MAX_PRERENDER_CACHE_ENTRIES = 64;

/**
 * Resolves the effective instrument of a render: the full descriptor when
 * given, otherwise the simple preset option wrapped as a 'synth-preset'
 * instrument (default 'e-piano').
 */
function resolveInstrument(
  options: PrerenderMidiClipOptions,
): Exclude<TrackInstrument, { kind: 'external-midi' }> {
  const instrument = options.instrument;
  if (instrument) {
    // External-MIDI tracks have no renderable internal instrument (their audio
    // comes from an external device). Preview/bounce them through the default
    // synth so auditioning still produces sound rather than silence/an error.
    if (instrument.kind === 'external-midi') {
      return { kind: 'synth-preset', preset: DEFAULT_SYNTH_PRESET };
    }
    return instrument;
  }
  return { kind: 'synth-preset', preset: options.preset ?? DEFAULT_SYNTH_PRESET };
}

/** Prerendered stereo buffers keyed by {@link midiClipCacheKey}. */
const renderCache = new Map<string, Float32Array[]>();

/** Clears the prerender cache (mainly for tests and memory pressure handling). */
export function clearPrerenderCache(): void {
  renderCache.clear();
}

function cachePrerender(key: string, channels: Float32Array[]): Float32Array[] {
  if (renderCache.has(key)) renderCache.delete(key);
  renderCache.set(key, channels);
  while (renderCache.size > MAX_PRERENDER_CACHE_ENTRIES) {
    const oldest = renderCache.keys().next().value;
    if (oldest === undefined) break;
    renderCache.delete(oldest);
  }
  return channels;
}

function cachedPrerender(key: string): Float32Array[] | undefined {
  const cached = renderCache.get(key);
  if (!cached) return undefined;
  renderCache.delete(key);
  renderCache.set(key, cached);
  return cached;
}

/** 32-bit FNV-1a hash of a string. */
function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Throws if a note has out-of-range or non-finite fields. */
function validateNote(n: MidiNote): void {
  const channel = n.channel ?? 0;
  if (!Number.isInteger(n.note) || n.note < 0 || n.note > 127) {
    throw new RangeError(`MIDI note must be an integer in [0, 127], got ${n.note}`);
  }
  if (!Number.isInteger(n.velocity) || n.velocity < 1 || n.velocity > 127) {
    throw new RangeError(`MIDI velocity must be an integer in [1, 127], got ${n.velocity}`);
  }
  if (
    n.offVelocity !== undefined &&
    (!Number.isInteger(n.offVelocity) || n.offVelocity < 0 || n.offVelocity > 127)
  ) {
    throw new RangeError(`MIDI offVelocity must be an integer in [0, 127], got ${n.offVelocity}`);
  }
  if (!Number.isInteger(channel) || channel < 0 || channel > 15) {
    throw new RangeError(`MIDI channel must be an integer in [0, 15], got ${channel}`);
  }
  if (!Number.isFinite(n.startPpq) || n.startPpq < 0) {
    throw new RangeError(`Note startPpq must be finite and >= 0, got ${n.startPpq}`);
  }
  if (!Number.isFinite(n.durationPpq) || n.durationPpq <= 0) {
    throw new RangeError(`Note durationPpq must be finite and > 0, got ${n.durationPpq}`);
  }
}

/**
 * Expands notes into a deterministic, sorted note-on/note-off event list.
 *
 * Events are ordered by PPQ; at equal PPQ note-offs come first (so a repeated
 * pitch releases before it retriggers), then by note and channel.
 *
 * @param notes Notes of the phrase; each note becomes one on/off pair.
 * @returns Sorted note boundary events.
 */
export function noteEventsFromNotes(notes: ReadonlyArray<MidiNote>): NoteEvent[] {
  const events: NoteEvent[] = [];
  for (const n of notes) {
    validateNote(n);
    const channel = n.channel ?? 0;
    events.push({ ppq: n.startPpq, kind: 'on', note: n.note, velocity: n.velocity, channel });
    events.push({
      ppq: n.startPpq + n.durationPpq,
      kind: 'off',
      note: n.note,
      velocity: n.offVelocity ?? 0,
      channel,
    });
  }
  events.sort(
    (a, b) =>
      a.ppq - b.ppq ||
      (a.kind === b.kind ? 0 : a.kind === 'off' ? -1 : 1) ||
      a.note - b.note ||
      a.channel - b.channel,
  );
  return events;
}

/**
 * Computes a deterministic cache key for a prerendered MIDI clip.
 *
 * The key covers everything that influences the rendered audio: note content
 * (order-insensitive), tempo, instrument identity (preset name, hashed patch
 * content, or SoundFont id + bank/program), GM mode and initial selection, and
 * sample rate.
 *
 * @param notes Notes of the phrase.
 * @param options Render options (sampleRate required; tempo/instrument use defaults).
 * @returns A stable string key.
 */
export function midiClipCacheKey(
  notes: ReadonlyArray<MidiNote>,
  options: PrerenderMidiClipOptions,
): string {
  const tempoBpm = options.tempoBpm ?? DEFAULT_TEMPO_BPM;
  const instrument = instrumentCacheSegment(resolveInstrument(options));
  const canonical = notes
    .map(
      (n) =>
        `${n.startPpq}:${n.durationPpq}:${n.note}:${n.velocity}:${n.offVelocity ?? 0}:${
          n.channel ?? 0
        }`,
    )
    .sort()
    .join(';');
  const hash = fnv1a32(canonical).toString(16).padStart(8, '0');
  return `${CACHE_KEY_VERSION}|sr=${options.sampleRate}|bpm=${tempoBpm}|${instrument}|n=${notes.length}|${hash}`;
}

/**
 * Splits an interleaved buffer into planar per-channel buffers.
 *
 * @param interleaved Interleaved samples (frame-major: L R L R ... for stereo).
 * @param channelCount Number of channels (default 2).
 * @returns One Float32Array per channel.
 */
export function deinterleave(interleaved: Float32Array, channelCount = 2): Float32Array[] {
  if (!Number.isInteger(channelCount) || channelCount < 1) {
    throw new RangeError(`channelCount must be a positive integer, got ${channelCount}`);
  }
  const frames = Math.floor(interleaved.length / channelCount);
  const channels: Float32Array[] = [];
  for (let c = 0; c < channelCount; c++) {
    const out = new Float32Array(frames);
    for (let i = 0; i < frames; i++) {
      out[i] = interleaved[i * channelCount + c];
    }
    channels.push(out);
  }
  return channels;
}

type WasmModule = typeof import('@/wasm/index.js');

/**
 * Validates a synth preset name against the runtime catalog when the module
 * exposes it, degrading unknown names to the default preset so a stale
 * document or template renders audibly instead of throwing. Modules without
 * the catalog function (older builds, test mocks) pass names through. Shared
 * by the prerender path and the realtime instrument sync.
 */
export function resolvePresetName(wasm: WasmModule, preset: string): string {
  const list = (wasm as { synthPresetNames?: () => string[] }).synthPresetNames;
  if (typeof list !== 'function') return preset;
  try {
    const bare = preset.startsWith('va:') ? preset.slice(3) : preset;
    return list().includes(bare) ? preset : DEFAULT_SYNTH_PRESET;
  } catch {
    return preset;
  }
}

/**
 * Builds the MIDI bank-select/program-change events injected at PPQ 0 for an
 * SF2 instrument, one set per channel the phrase uses. Each channel resolves
 * to its {@link Sf2Instrument.channelMap} entry when present (multi-timbral
 * GM/GS module), otherwise the track-level bank/program.
 */
function sf2ProgramEvents(
  wasm: WasmModule,
  instrument: Extract<TrackInstrument, { kind: 'sf2' }>,
  channels: ReadonlyArray<number>,
): ProjectMidiEvent[] {
  const events: ProjectMidiEvent[] = [];
  for (const channel of channels) {
    const resolved = sf2ChannelProgram(instrument, channel);
    if (resolved === null) continue;
    const program = resolved.program ?? 0;
    if (resolved.bank !== undefined && typeof wasm.Project.midiBankProgram === 'function') {
      const bankMsb = (resolved.bank >> 7) & 0x7f;
      const bankLsb = resolved.bank & 0x7f;
      events.push(...wasm.Project.midiBankProgram(0, 0, channel, bankMsb, bankLsb, program));
    } else {
      events.push(wasm.Project.midiProgram(0, 0, channel, program));
    }
  }
  return events;
}

/** Builds the initial GM bank/program events for a NativeSynth preset. */
function synthPresetProgramEvents(
  wasm: WasmModule,
  instrument: SynthPresetInstrument,
  channels: ReadonlyArray<number>,
): ProjectMidiEvent[] {
  if (
    instrument.useGmPrograms !== true ||
    (instrument.gmBank === undefined && instrument.gmProgram === undefined)
  ) {
    return [];
  }
  const events: ProjectMidiEvent[] = [];
  const program = instrument.gmProgram ?? 0;
  for (const channel of channels) {
    if (instrument.gmBank !== undefined && typeof wasm.Project.midiBankProgram === 'function') {
      const bankMsb = (instrument.gmBank >> 7) & 0x7f;
      const bankLsb = instrument.gmBank & 0x7f;
      events.push(...wasm.Project.midiBankProgram(0, 0, channel, bankMsb, bankLsb, program));
    } else {
      events.push(wasm.Project.midiProgram(0, 0, channel, program));
    }
  }
  return events;
}

/**
 * Renders a MIDI phrase offline to planar stereo audio using the libsonare
 * instrument selected by the options (NativeSynth preset or patch, or a
 * stored SoundFont), caching results by content.
 *
 * The render length is auto-derived by the bounce (including the synth release
 * tail), so the returned buffers may extend slightly past the last note-off.
 *
 * @param notes Notes of the phrase (clip-relative PPQ).
 * @param options Render options; sampleRate must match the playback AudioContext.
 * @returns Planar stereo buffers ([left, right]) ready for engine.addClip.
 */
export async function prerenderMidiClip(
  notes: ReadonlyArray<MidiNote>,
  options: PrerenderMidiClipOptions,
): Promise<Float32Array[]> {
  const key = midiClipCacheKey(notes, options);
  const cached = cachedPrerender(key);
  if (cached) return cached;

  if (notes.length === 0) {
    const empty = [new Float32Array(0), new Float32Array(0)];
    return cachePrerender(key, empty);
  }

  const wasm = await ensureWasm();
  const tempoBpm = options.tempoBpm ?? DEFAULT_TEMPO_BPM;
  const instrument = resolveInstrument(options);
  const events = noteEventsFromNotes(notes);
  const lengthPpq = Math.max(1, Math.ceil(events[events.length - 1].ppq));

  // SoundFont bytes are loaded before the scratch project exists so a missing
  // font fails fast without touching wasm state.
  let fontData: Uint8Array | null = null;
  if (instrument.kind === 'sf2') {
    const load = options.loadFont ?? loadStoredFont;
    fontData = await load(instrument.fontId);
  }

  const project = new wasm.Project();
  try {
    project.setSampleRate(options.sampleRate);
    project.setTempoSegments([{ startPpq: 0, bpm: tempoBpm }]);
    const { clipId } = project.addMidiClip(0, lengthPpq);
    const noteEvents = events.map((e) =>
      e.kind === 'on'
        ? wasm.Project.midiNoteOn(e.ppq, 0, e.channel, e.note, e.velocity)
        : wasm.Project.midiNoteOff(e.ppq, 0, e.channel, e.note, e.velocity),
    );
    const usedChannels = [...new Set(events.map((e) => e.channel))];
    let interleaved: Float32Array;
    if (instrument.kind === 'sf2') {
      project.loadSoundFont(fontData as Uint8Array);
      const programEvents = sf2ProgramEvents(wasm, instrument, usedChannels);
      // The engine orders same-frame events non-stably.  A bank/program
      // prelude at PPQ 0 must therefore precede a phrase that starts at 0,
      // just as the realtime scheduler shifts its frame-zero phrase events.
      // One sample is inaudible and remains accurate for the configured tempo.
      const preludeSafeNoteEvents =
        programEvents.length === 0
          ? noteEvents
          : noteEvents.map((event) =>
              event.ppq === 0 ? { ...event, ppq: tempoBpm / (60 * options.sampleRate) } : event,
            );
      project.setMidiEvents(clipId, [...programEvents, ...preludeSafeNoteEvents]);
      interleaved = project.bounceWithSf2Instrument(sf2PlaybackConfig(instrument), {
        numChannels: 2,
      });
    } else {
      const programEvents =
        instrument.kind === 'synth-preset'
          ? synthPresetProgramEvents(wasm, instrument, usedChannels)
          : [];
      // A GM prelude at PPQ 0 must precede a phrase that starts at 0, just as
      // the realtime scheduler shifts its frame-zero phrase events.
      const preludeSafeNoteEvents =
        programEvents.length === 0
          ? noteEvents
          : noteEvents.map((event) =>
              event.ppq === 0 ? { ...event, ppq: tempoBpm / (60 * options.sampleRate) } : event,
            );
      project.setMidiEvents(clipId, [...programEvents, ...preludeSafeNoteEvents]);
      const patch =
        instrument.kind === 'synth-patch'
          ? instrument.patch
          : instrument.useGmPrograms === true
            ? { preset: resolvePresetName(wasm, instrument.preset), useGmPrograms: true }
            : resolvePresetName(wasm, instrument.preset);
      interleaved = project.bounceWithSynthInstrument(patch, { numChannels: 2 });
    }
    const channels = deinterleave(interleaved, 2);
    return cachePrerender(key, channels);
  } finally {
    project.delete();
  }
}

/**
 * Builds a short demo phrase: a two-bar C-major arpeggio in eighth notes
 * (C4 E4 G4 C5 E5 C5 G4 E4, repeated), used for the first sound check.
 *
 * @returns Notes spanning PPQ [0, 8) at 4/4.
 */
export function makeDemoNotes(): MidiNote[] {
  const pattern = [60, 64, 67, 72, 76, 72, 67, 64];
  const notes: MidiNote[] = [];
  for (let bar = 0; bar < 2; bar++) {
    pattern.forEach((note, i) => {
      notes.push({
        note,
        velocity: i === 0 ? 110 : 92,
        startPpq: bar * 4 + i * 0.5,
        durationPpq: 0.45,
      });
    });
  }
  return notes;
}

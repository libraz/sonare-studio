import { ensureWasm } from '@/lib/wasm';
import type { EngineHandle } from './engine';

/** One note of a MIDI phrase, positioned in quarter-note pulses (PPQ). */
export interface MidiNote {
  /** MIDI note number (integer, 0-127). */
  note: number;
  /** Note-on velocity (integer, 1-127). */
  velocity: number;
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
  /** NativeSynth preset name rendered via bounceWithSynthInstrument (default 'e-piano'). */
  preset?: string;
}

/** Options for {@link scheduleMidiClip}; sampleRate defaults to the engine context rate. */
export type ScheduleMidiClipOptions = Partial<PrerenderMidiClipOptions>;

/** A note-on or note-off boundary derived from a {@link MidiNote} list. */
export interface NoteEvent {
  /** Event position in PPQ. */
  ppq: number;
  /** 'off' events sort before 'on' events at the same PPQ to avoid retrigger glitches. */
  kind: 'off' | 'on';
  /** MIDI note number (0-127). */
  note: number;
  /** Velocity (note-on velocity for 'on', 0 for 'off'). */
  velocity: number;
  /** MIDI channel (0-15). */
  channel: number;
}

const DEFAULT_TEMPO_BPM = 120;
const DEFAULT_PRESET = 'e-piano';
const CACHE_KEY_VERSION = 'v1';

/** Prerendered stereo buffers keyed by {@link midiClipCacheKey}. */
const renderCache = new Map<string, Float32Array[]>();

/** Clears the prerender cache (mainly for tests and memory pressure handling). */
export function clearPrerenderCache(): void {
  renderCache.clear();
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
      velocity: 0,
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
 * (order-insensitive), tempo, instrument preset, and sample rate.
 *
 * @param notes Notes of the phrase.
 * @param options Render options (sampleRate required; tempo/preset use defaults).
 * @returns A stable string key.
 */
export function midiClipCacheKey(
  notes: ReadonlyArray<MidiNote>,
  options: PrerenderMidiClipOptions,
): string {
  const tempoBpm = options.tempoBpm ?? DEFAULT_TEMPO_BPM;
  const preset = options.preset ?? DEFAULT_PRESET;
  const canonical = notes
    .map((n) => `${n.startPpq}:${n.durationPpq}:${n.note}:${n.velocity}:${n.channel ?? 0}`)
    .sort()
    .join(';');
  const hash = fnv1a32(canonical).toString(16).padStart(8, '0');
  return `${CACHE_KEY_VERSION}|sr=${options.sampleRate}|bpm=${tempoBpm}|preset=${encodeURIComponent(
    preset,
  )}|n=${notes.length}|${hash}`;
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

/**
 * Renders a MIDI phrase offline to planar stereo audio using the libsonare
 * NativeSynth instrument, caching results by content.
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
  const cached = renderCache.get(key);
  if (cached) return cached;

  if (notes.length === 0) {
    const empty = [new Float32Array(0), new Float32Array(0)];
    renderCache.set(key, empty);
    return empty;
  }

  const wasm = await ensureWasm();
  const tempoBpm = options.tempoBpm ?? DEFAULT_TEMPO_BPM;
  const preset = options.preset ?? DEFAULT_PRESET;
  const events = noteEventsFromNotes(notes);
  const lengthPpq = Math.max(1, Math.ceil(events[events.length - 1].ppq));

  const project = new wasm.Project();
  try {
    project.setSampleRate(options.sampleRate);
    project.setTempoSegments([{ startPpq: 0, bpm: tempoBpm }]);
    const { clipId } = project.addMidiClip(0, lengthPpq);
    project.setMidiEvents(
      clipId,
      events.map((e) =>
        e.kind === 'on'
          ? wasm.Project.midiNoteOn(e.ppq, 0, e.channel, e.note, e.velocity)
          : wasm.Project.midiNoteOff(e.ppq, 0, e.channel, e.note),
      ),
    );
    const interleaved = project.bounceWithSynthInstrument(preset, { numChannels: 2 });
    const channels = deinterleave(interleaved, 2);
    renderCache.set(key, channels);
    return channels;
  } finally {
    project.delete();
  }
}

/**
 * Prerenders a MIDI phrase and schedules the resulting audio on the engine.
 *
 * @param handle Running engine handle from createEngine.
 * @param trackId Target track identifier passed through to engine.addClip.
 * @param notes Notes of the phrase (clip-relative PPQ).
 * @param startPpq Timeline position of the clip start, in PPQ.
 * @param options Optional render overrides; sampleRate defaults to the engine context rate.
 * @returns The engine clip id (use engine.removeClip(clipId) to unschedule).
 */
export async function scheduleMidiClip(
  handle: EngineHandle,
  trackId: string | number,
  notes: ReadonlyArray<MidiNote>,
  startPpq: number,
  options: ScheduleMidiClipOptions = {},
): Promise<number> {
  const channels = await prerenderMidiClip(notes, {
    sampleRate: options.sampleRate ?? handle.ctx.sampleRate,
    tempoBpm: options.tempoBpm,
    preset: options.preset,
  });
  return handle.engine.addClip(trackId, channels, startPpq);
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

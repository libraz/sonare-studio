/**
 * Realtime MIDI synchronisation: compiles the store's MIDI clips into engine
 * MIDI clip schedules and mirrors per-track instruments onto a running
 * engine, transmitting only what changed.
 *
 * Engine contract (libsonare):
 * - setMidiClips replaces the whole scheduled clip set and is NOT gated
 *   during playback: a send while the transport plays takes effect live.
 * - Each event's renderFrame is an ABSOLUTE sample position on the render
 *   timeline (not clip-relative); startSample/lengthSamples are absolute
 *   samples too. startPpq is carried for diagnostics only — the engine never
 *   converts PPQ, so the caller bakes PPQ to samples through the current
 *   tempo map and must re-send the clips after a tempo-map change.
 * - The engine sorts events by renderFrame with a NON-stable sort, so
 *   same-frame ordering is undefined; the builder avoids same-frame
 *   collisions wherever ordering matters (note-off vs note-on, program
 *   prelude vs first note).
 * - Instrument routing: an instrument bound to destination id D renders into
 *   the mixer lane whose track id is D (lanes are declared by mixer-sync).
 *   Instrument syncs are stop-gated by the engine facade itself (deferred
 *   while the transport plays, flushed on stop) — no extra gating here.
 * - loadSoundFont is GLOBAL: the engine holds a single SoundFont, so tracks
 *   needing different fonts cannot be honored — the last loaded font wins.
 * - Scheduled MIDI clips have no gain field; clip gain is expressed by
 *   scaling note-on velocities.
 */

import { loadFont } from '@/project/fonts';
import { DEFAULT_SYNTH_PRESET } from '@/project/instrument';
import { clipPlaybackNotes } from '@/project/scheduling';
import { normalizeTempoMap, ppqToSamples } from '@/project/tempo-map';
import { clipKind, type EditorClip, type EditorTrack, type TempoSegment } from '@/project/types';
import type { EngineMidiClipSchedule, EngineMidiEvent } from '@/wasm/index.js';
import type { EngineHandle } from './engine';

/** MIDI 1.0 channel-voice status nibbles used by the builder. */
const STATUS_NOTE_ON = 0x9;
const STATUS_NOTE_OFF = 0x8;
const STATUS_CONTROL_CHANGE = 0xb;
const STATUS_PROGRAM_CHANGE = 0xc;

/** Bank-select controller numbers (MSB / LSB). */
const CC_BANK_SELECT_MSB = 0;
const CC_BANK_SELECT_LSB = 32;

/** Clamps a value into [min, max]. */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Encodes a UMP MIDI 1.0 channel-voice word (message type 0x2, group 0).
 *
 * @param status Status nibble (e.g. 0x9 note-on).
 * @param channel MIDI channel (0-15).
 * @param data0 First 7-bit data byte.
 * @param data1 Second 7-bit data byte.
 * @returns The 32-bit word0 of a wordCount-1 event.
 */
function channelVoiceWord(status: number, channel: number, data0: number, data1: number): number {
  return (
    (0x2 << 28) |
    ((status & 0xf) << 20) |
    ((channel & 0xf) << 16) |
    ((data0 & 0x7f) << 8) |
    (data1 & 0x7f)
  );
}

/** Builds a single-word channel-voice event at an absolute render frame. */
function voiceEvent(
  renderFrame: number,
  status: number,
  channel: number,
  data0: number,
  data1: number,
): EngineMidiEvent {
  return { renderFrame, word0: channelVoiceWord(status, channel, data0, data1), wordCount: 1 };
}

/**
 * Compiles the MIDI clips of the given tracks into engine clip schedules
 * (exported for tests). Only clips on 'midi' tracks with MIDI content, notes
 * and an audible gain are scheduled; clip gain is baked into the note-on
 * velocities. All PPQ positions are converted to absolute samples through the
 * given tempo map, so tempo changes and ramps inside a clip land on exact
 * frames (a clip's length is the sample distance between its start and end
 * positions, not a rounded duration).
 *
 * Note-offs are placed one sample before the note's nominal end (clamped to
 * the clip window, and never before noteOn + 1): the engine's same-frame
 * event order is undefined, so a legato note-off must sit strictly before a
 * same-pitch note-on of the following note.
 *
 * SF2 instruments with an explicit bank and/or program get a per-channel
 * program prelude (bank-select CCs, then program change) one sample before
 * the clip start. A clip starting at sample 0 has no earlier sample, so the
 * prelude sits at frame 0 and the clip's own frame-0 note events are shifted
 * to frame 1 (one sample, inaudible) to keep the prelude strictly first.
 *
 * @param tracks Project tracks (clip track lookup and instrument source).
 * @param clips Project clips to compile.
 * @param tempoSegments Project tempo segments (empty falls back to 120 BPM).
 * @param sampleRate Render sample rate in Hz (finite, > 0).
 * @returns Schedules sorted by clip id, each with events sorted by frame.
 */
export function buildMidiClipSchedules(
  tracks: ReadonlyArray<EditorTrack>,
  clips: ReadonlyArray<EditorClip>,
  tempoSegments: ReadonlyArray<TempoSegment>,
  sampleRate: number,
): EngineMidiClipSchedule[] {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new RangeError(`Sample rate must be finite and > 0, got ${sampleRate}`);
  }
  const tempoMap = normalizeTempoMap(tempoSegments);
  const trackById = new Map(tracks.map((track) => [track.id, track]));
  const schedules: EngineMidiClipSchedule[] = [];

  for (const clip of clips) {
    const track = trackById.get(clip.trackId);
    if (track?.kind !== 'midi' || clipKind(clip) !== 'midi') continue;
    const notes = clipPlaybackNotes(clip);
    if (notes.length === 0 || clip.gain <= 0) continue;

    const startSample = ppqToSamples(tempoMap, clip.startPpq, sampleRate);
    // End minus start (not a rounded duration), so tempo-segment boundaries
    // inside the clip stay exact.
    const lengthSamples =
      ppqToSamples(tempoMap, clip.startPpq + clip.lengthPpq, sampleRate) - startSample;
    const events: EngineMidiEvent[] = [];

    const instrument = track.instrument;
    const sf2 = instrument?.kind === 'sf2' ? instrument : undefined;
    const hasPrelude = sf2 !== undefined && (sf2.bank !== undefined || sf2.program !== undefined);
    if (sf2 && hasPrelude) {
      const { bank, program } = sf2;
      const preludeFrame = Math.max(0, startSample - 1);
      const channels = new Set(notes.map((note) => clamp(note.channel ?? 0, 0, 15)));
      for (const channel of channels) {
        if (bank !== undefined) {
          events.push(
            voiceEvent(preludeFrame, STATUS_CONTROL_CHANGE, channel, CC_BANK_SELECT_MSB, bank >> 7),
          );
          events.push(
            voiceEvent(
              preludeFrame,
              STATUS_CONTROL_CHANGE,
              channel,
              CC_BANK_SELECT_LSB,
              bank & 0x7f,
            ),
          );
        }
        events.push(voiceEvent(preludeFrame, STATUS_PROGRAM_CHANGE, channel, program ?? 0, 0));
      }
    }
    // A frame-0 prelude has no earlier sample to occupy, so the clip's own
    // frame-0 note events move to frame 1 to keep the prelude strictly first
    // under the engine's unstable same-frame sort.
    const shiftFrameZero = hasPrelude && startSample === 0;

    for (const note of notes) {
      const channel = clamp(note.channel ?? 0, 0, 15);
      const velocity = clamp(Math.round(note.velocity * clip.gain), 1, 127);
      let onFrame = ppqToSamples(tempoMap, clip.startPpq + note.startPpq, sampleRate);
      if (shiftFrameZero && onFrame === 0) onFrame = 1;
      // One sample before the nominal end keeps this note-off strictly before
      // a same-pitch note-on of the next note (legato) despite the engine's
      // unstable same-frame sort; the floor keeps the note at least 1 sample.
      const endPpq = Math.min(note.startPpq + note.durationPpq, clip.lengthPpq);
      const offFrame = Math.max(
        onFrame + 1,
        ppqToSamples(tempoMap, clip.startPpq + endPpq, sampleRate) - 1,
      );
      events.push(voiceEvent(onFrame, STATUS_NOTE_ON, channel, note.note, velocity));
      events.push(voiceEvent(offFrame, STATUS_NOTE_OFF, channel, note.note, 0));
    }

    events.sort((a, b) => a.renderFrame - b.renderFrame);
    schedules.push({
      id: clip.id,
      trackId: clip.trackId,
      destinationId: clip.trackId,
      startSample,
      startPpq: clip.startPpq,
      lengthSamples,
      events,
    });
  }

  schedules.sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
  return schedules;
}

/** Options for {@link createMidiSync}. */
export interface MidiSyncOptions {
  /** Loads SoundFont bytes by font id; defaults to the OPFS font store's loadFont. */
  loadFont?: (fontId: string) => Promise<Uint8Array>;
  /** Maps a synth preset name to a known catalog name; defaults to identity. */
  resolvePreset?: (preset: string) => string;
}

/** Mirrors store MIDI clips and track instruments onto a running engine. */
export interface MidiSync {
  /**
   * Diffs instruments and the compiled clip set against what was last sent.
   * Instruments are sent first, then the clips (one replace-all setMidiClips
   * when the compiled schedules changed). Errors propagate to the caller.
   *
   * @param tracks Project tracks in store order.
   * @param clips Project clips.
   * @param tempoSegments Project tempo segments the clip frames are baked
   *   through (empty falls back to 120 BPM).
   */
  sync(
    tracks: ReadonlyArray<EditorTrack>,
    clips: ReadonlyArray<EditorClip>,
    tempoSegments: ReadonlyArray<TempoSegment>,
  ): Promise<void>;
  /** Number of MIDI clip schedules in the last setMidiClips call (0 before any). */
  scheduledClipCount(): number;
}

/**
 * Creates a MIDI sync bound to one engine handle. Create a fresh instance per
 * engine start: all sent-state memory (instruments, loaded SoundFont,
 * compiled clip set) restarts with the engine.
 *
 * @param handle Running engine handle from createEngine.
 * @param options Optional font loader and preset resolver overrides.
 * @returns The sync facade.
 */
export function createMidiSync(handle: EngineHandle, options: MidiSyncOptions = {}): MidiSync {
  const loadFontBytes = options.loadFont ?? loadFont;
  const resolvePreset = options.resolvePreset ?? ((preset: string) => preset);
  const lastInstrumentKeyByTrack = new Map<number, string>();
  let loadedFontId: string | undefined;
  let lastClipsKey: string | undefined;
  let clipCount = 0;

  const sync = async (
    tracks: ReadonlyArray<EditorTrack>,
    clips: ReadonlyArray<EditorClip>,
    tempoSegments: ReadonlyArray<TempoSegment>,
  ): Promise<void> => {
    const sampleRate = handle.ctx.sampleRate;

    // The engine holds a single global SoundFont: with several distinct
    // fonts requested the last one loaded wins, so make that audible.
    const fontIds = new Set<string>();
    for (const track of tracks) {
      if (track.kind === 'midi' && track.instrument?.kind === 'sf2') {
        fontIds.add(track.instrument.fontId);
      }
    }
    if (fontIds.size > 1) {
      console.warn(
        `MIDI sync: ${fontIds.size} distinct SoundFonts requested, but the engine holds a single global SoundFont — the last loaded font wins.`,
      );
    }

    for (const track of tracks) {
      if (track.kind !== 'midi') continue;
      const instrumentKey = JSON.stringify(track.instrument ?? null);
      if (lastInstrumentKeyByTrack.get(track.id) === instrumentKey) continue;
      const instrument = track.instrument;
      if (instrument === undefined) {
        handle.engine.setSynthInstrument(track.id, resolvePreset(DEFAULT_SYNTH_PRESET));
      } else if (instrument.kind === 'synth-preset') {
        handle.engine.setSynthInstrument(track.id, resolvePreset(instrument.preset));
      } else if (instrument.kind === 'synth-patch') {
        handle.engine.setSynthInstrument(track.id, instrument.patch as Record<string, unknown>);
      } else {
        if (instrument.fontId !== loadedFontId) {
          const bytes = await loadFontBytes(instrument.fontId);
          handle.engine.loadSoundFont(bytes);
          loadedFontId = instrument.fontId;
        }
        handle.engine.setSf2Instrument(track.id, {});
      }
      lastInstrumentKeyByTrack.set(track.id, instrumentKey);
    }

    const schedules = buildMidiClipSchedules(tracks, clips, tempoSegments, sampleRate);
    const clipsKey = JSON.stringify(schedules);
    if (clipsKey !== lastClipsKey) {
      handle.engine.setMidiClips(schedules);
      lastClipsKey = clipsKey;
      clipCount = schedules.length;
    }
  };

  return { sync, scheduledClipCount: () => clipCount };
}

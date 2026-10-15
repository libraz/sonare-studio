import { getCurrentScope, onScopeDispose, type Ref, type ShallowRef } from 'vue';
import { preferredNoteChannel } from '@/compose/tracks';
import type { EngineHandle } from '@/engine/engine';
import {
  type MidiNote,
  normalizeGain,
  peakAmplitude,
  prerenderMidiClip,
} from '@/engine/instruments';
import { describeError } from '@/lib/errors';
import { useProjectStore } from '@/project/store';

const PREVIEW_DURATION_PPQ = 0.5;
const PREVIEW_TARGET_PEAK = 0.5;
/**
 * Safety release for a sustained live note: if the matching key-up is ever
 * lost (engine swap, dropped MIDI message) the note is released after this
 * many milliseconds rather than hanging forever.
 */
const SUSTAIN_SAFETY_MS = 10000;

export interface NotePreviewOptions {
  errorMessage: Ref<string>;
  handle: ShallowRef<EngineHandle | null>;
  hasMidiSync: () => boolean;
  ensureEngineStarted: () => Promise<EngineHandle | null>;
  /** Direct live route used by external-MIDI tracks for channel voice not exposed by the engine ABI. */
  sendLiveExternalMidi?: (
    destinationId: number,
    bytes: ReadonlyArray<number>,
    timestampMs?: number,
  ) => boolean;
}

export type LiveMidiChannelVoiceMessage =
  | { kind: 'cc'; channel: number; controller: number; value: number; timeStampMs?: number }
  | { kind: 'pitch-bend'; channel: number; value: number; timeStampMs?: number }
  | { kind: 'program-change'; channel: number; program: number; timeStampMs?: number }
  | { kind: 'channel-pressure'; channel: number; value: number; timeStampMs?: number }
  | { kind: 'poly-pressure'; channel: number; pitch: number; value: number; timeStampMs?: number };

export function useNotePreview(options: NotePreviewOptions) {
  const store = useProjectStore();

  /** Sustained live notes keyed by channel+pitch, including their output path. */
  const heldNotes = new Map<
    string,
    {
      trackId: number;
      channel: number;
      directExternal: boolean;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const auditionTimers = new Set<{
    pitch: number;
    channel: number;
    timer: ReturnType<typeof setTimeout>;
    trackId: number;
  }>();

  /** Channel the active track's written notes use (GM channel 10 on drum tracks). */
  function activeTrackChannel(): number {
    const track = store.activeTrack;
    const notes = track
      ? (store.clipsByTrack.get(track.id) ?? []).flatMap((item) => item.notes)
      : store.notes;
    return preferredNoteChannel(track, notes);
  }

  /** True when the active track can sustain live MIDI through the engine. */
  function activeMidiTrackId(): number | null {
    const activeTrack = store.tracks.find((track) => track.id === store.activeTrackId);
    if (activeTrack && activeTrack.kind === 'midi' && options.hasMidiSync()) {
      return activeTrack.id;
    }
    return null;
  }

  /** Releases one held note: clears its timer and pushes the engine note-off. */
  function heldKey(channel: number, pitch: number): string {
    return `${channel & 0x0f}:${pitch & 0x7f}`;
  }

  function releaseHeld(pitch: number, channel: number, velocity = 0, timestampMs?: number): void {
    const key = heldKey(channel, pitch);
    const held = heldNotes.get(key);
    if (!held) return;
    heldNotes.delete(key);
    clearTimeout(held.timer);
    try {
      if (held.directExternal) {
        options.sendLiveExternalMidi?.(
          held.trackId,
          [0x80 | held.channel, pitch & 0x7f, velocity & 0x7f],
          timestampMs,
        );
      } else {
        if (velocity === 0) {
          options.handle.value?.engine.pushMidiNoteOff(held.trackId, 0, held.channel, pitch);
        } else {
          options.handle.value?.engine.pushMidiNoteOff(
            held.trackId,
            0,
            held.channel,
            pitch,
            velocity,
          );
        }
      }
    } catch {
      // The engine may be disposed; releasing a gone note is harmless.
    }
  }

  function pushNoteOff(trackId: number, pitch: number, channel: number): void {
    try {
      options.handle.value?.engine.pushMidiNoteOff(trackId, 0, channel, pitch);
    } catch {
      // The engine may be disposed before the note-off path runs.
    }
  }

  function releaseAudition(entry: {
    pitch: number;
    channel: number;
    timer: ReturnType<typeof setTimeout>;
    trackId: number;
  }): void {
    if (!auditionTimers.delete(entry)) return;
    clearTimeout(entry.timer);
    pushNoteOff(entry.trackId, entry.pitch, entry.channel);
  }

  /**
   * Starts a sustained live note (e.g. a held MIDI key). On a MIDI track this
   * pushes a note-on that rings until {@link previewNoteOff}; on any other
   * active track it degrades to a short one-shot audition (no sustain concept).
   */
  async function previewNoteOn(
    pitch: number,
    velocity: number,
    requestedChannel?: number,
    timestampMs?: number,
  ): Promise<void> {
    const trackId = activeMidiTrackId();
    if (trackId === null) {
      await previewNote(pitch, velocity);
      return;
    }
    const h = await options.ensureEngineStarted();
    if (!h || activeMidiTrackId() !== trackId) return;
    const channel = requestedChannel ?? activeTrackChannel();
    // Retrigger: release a still-held instance of the same pitch first.
    releaseHeld(pitch, channel);
    const directExternal =
      options.sendLiveExternalMidi?.(
        trackId,
        [0x90 | (channel & 0x0f), pitch & 0x7f, velocity & 0x7f],
        timestampMs,
      ) === true;
    try {
      if (!directExternal) h.engine.pushMidiNoteOn(trackId, 0, channel, pitch, velocity);
    } catch (err) {
      options.errorMessage.value = describeError(err);
      return;
    }
    const timer = setTimeout(() => releaseHeld(pitch, channel), SUSTAIN_SAFETY_MS);
    heldNotes.set(heldKey(channel, pitch), { trackId, channel, directExternal, timer });
  }

  /**
   * Releases a sustained live note started by {@link previewNoteOn}. Without a
   * channel, releases the held note of that pitch on whatever channel it began.
   */
  function previewNoteOff(
    pitch: number,
    channel?: number,
    velocity = 0,
    timestampMs?: number,
  ): void {
    if (channel !== undefined) {
      releaseHeld(pitch, channel, velocity, timestampMs);
      return;
    }
    for (const key of [...heldNotes.keys()]) {
      const [heldChannel, heldPitch] = key.split(':').map(Number);
      if (heldPitch === (pitch & 0x7f)) releaseHeld(pitch, heldChannel, velocity, timestampMs);
    }
  }

  /** Releases every sustained note (engine teardown / scope dispose). */
  function releaseAll(): void {
    for (const key of [...heldNotes.keys()]) {
      const [channel, pitch] = key.split(':').map(Number);
      releaseHeld(pitch, channel);
    }
    for (const entry of [...auditionTimers]) releaseAudition(entry);
  }

  function channelVoiceBytes(message: LiveMidiChannelVoiceMessage): number[] {
    const channel = message.channel & 0x0f;
    if (message.kind === 'cc') {
      return [0xb0 | channel, message.controller & 0x7f, message.value & 0x7f];
    }
    if (message.kind === 'pitch-bend') {
      const value = Math.max(0, Math.min(0x3fff, Math.round(message.value)));
      return [0xe0 | channel, value & 0x7f, value >> 7];
    }
    if (message.kind === 'program-change') {
      return [0xc0 | channel, message.program & 0x7f];
    }
    if (message.kind === 'channel-pressure') {
      return [0xd0 | channel, message.value & 0x7f];
    }
    return [0xa0 | channel, message.pitch & 0x7f, message.value & 0x7f];
  }

  /** Routes incoming non-note channel voice to the active MIDI track. */
  async function previewChannelVoice(message: LiveMidiChannelVoiceMessage): Promise<void> {
    const trackId = activeMidiTrackId();
    if (trackId === null) return;
    const h = await options.ensureEngineStarted();
    if (!h || activeMidiTrackId() !== trackId) return;
    if (options.sendLiveExternalMidi?.(trackId, channelVoiceBytes(message), message.timeStampMs)) {
      return;
    }
    try {
      const { engine } = h;
      const channel = message.channel;
      if (message.kind === 'cc') {
        engine.pushMidiCc(trackId, 0, channel, message.controller, message.value);
      } else if (message.kind === 'pitch-bend') {
        engine.pushMidiPitchBend(trackId, 0, channel, message.value);
      } else if (message.kind === 'program-change') {
        engine.pushMidiProgram(trackId, 0, channel, message.program);
      } else if (message.kind === 'channel-pressure') {
        engine.pushMidiChannelPressure(trackId, 0, channel, message.value);
      } else {
        engine.pushMidiPolyPressure(trackId, 0, channel, message.pitch, message.value);
      }
    } catch (err) {
      options.errorMessage.value = describeError(err);
    }
  }

  async function previewNote(pitch: number, velocity: number): Promise<void> {
    const h = await options.ensureEngineStarted();
    if (!h) return;
    const activeTrack = store.tracks.find((track) => track.id === store.activeTrackId);
    if (activeTrack && activeTrack.kind === 'midi' && options.hasMidiSync()) {
      const durationMs = (PREVIEW_DURATION_PPQ * 60000) / Math.max(1, store.tempoBpm);
      const channel = activeTrackChannel();
      try {
        h.engine.pushMidiNoteOn(activeTrack.id, 0, channel, pitch, velocity);
        const entry = {
          pitch,
          channel,
          trackId: activeTrack.id,
          timer: setTimeout(() => {
            if (!auditionTimers.delete(entry)) return;
            pushNoteOff(activeTrack.id, pitch, channel);
          }, durationMs),
        };
        auditionTimers.add(entry);
      } catch (err) {
        options.errorMessage.value = describeError(err);
      }
      return;
    }

    const phrase: MidiNote[] = [
      { note: pitch, velocity, startPpq: 0, durationPpq: PREVIEW_DURATION_PPQ },
    ];
    try {
      const channels = await prerenderMidiClip(phrase, { sampleRate: h.ctx.sampleRate });
      if (channels.length === 0 || channels[0].length === 0 || options.handle.value !== h) return;
      const buffer = h.ctx.createBuffer(channels.length, channels[0].length, h.ctx.sampleRate);
      for (let i = 0; i < channels.length; i++) {
        buffer.getChannelData(i).set(channels[i]);
      }
      const gain = h.ctx.createGain();
      gain.gain.value = normalizeGain(peakAmplitude(channels), PREVIEW_TARGET_PEAK);
      const source = h.ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(gain).connect(h.ctx.destination);
      source.onended = () => {
        source.disconnect();
        gain.disconnect();
      };
      source.start();
    } catch (err) {
      options.errorMessage.value = describeError(err);
    }
  }

  function auditionNote(pitch: number, velocity: number): void {
    void previewNote(pitch, velocity);
  }

  if (getCurrentScope()) {
    onScopeDispose(releaseAll);
  }

  return {
    auditionNote,
    previewNote,
    previewNoteOn,
    previewNoteOff,
    previewChannelVoice,
    releaseAll,
  };
}

import type { Ref, ShallowRef } from 'vue';
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
}

export function useNotePreview(options: NotePreviewOptions) {
  const store = useProjectStore();

  /** Sustained live notes keyed by pitch: the track they sound on + a safety timer. */
  const heldNotes = new Map<number, { trackId: number; timer: ReturnType<typeof setTimeout> }>();

  /** True when the active track can sustain live MIDI through the engine. */
  function activeMidiTrackId(): number | null {
    const activeTrack = store.tracks.find((track) => track.id === store.activeTrackId);
    if (activeTrack && activeTrack.kind === 'midi' && options.hasMidiSync()) {
      return activeTrack.id;
    }
    return null;
  }

  /** Releases one held note: clears its timer and pushes the engine note-off. */
  function releaseHeld(pitch: number): void {
    const held = heldNotes.get(pitch);
    if (!held) return;
    heldNotes.delete(pitch);
    clearTimeout(held.timer);
    try {
      options.handle.value?.engine.pushMidiNoteOff(held.trackId, 0, 0, pitch);
    } catch {
      // The engine may be disposed; releasing a gone note is harmless.
    }
  }

  /**
   * Starts a sustained live note (e.g. a held MIDI key). On a MIDI track this
   * pushes a note-on that rings until {@link previewNoteOff}; on any other
   * active track it degrades to a short one-shot audition (no sustain concept).
   */
  async function previewNoteOn(pitch: number, velocity: number): Promise<void> {
    const trackId = activeMidiTrackId();
    if (trackId === null) {
      await previewNote(pitch, velocity);
      return;
    }
    const h = await options.ensureEngineStarted();
    if (!h || activeMidiTrackId() !== trackId) return;
    // Retrigger: release a still-held instance of the same pitch first.
    releaseHeld(pitch);
    try {
      h.engine.pushMidiNoteOn(trackId, 0, 0, pitch, velocity);
    } catch (err) {
      options.errorMessage.value = describeError(err);
      return;
    }
    const timer = setTimeout(() => releaseHeld(pitch), SUSTAIN_SAFETY_MS);
    heldNotes.set(pitch, { trackId, timer });
  }

  /** Releases a sustained live note started by {@link previewNoteOn}. */
  function previewNoteOff(pitch: number): void {
    releaseHeld(pitch);
  }

  /** Releases every sustained note (engine teardown / scope dispose). */
  function releaseAll(): void {
    for (const pitch of [...heldNotes.keys()]) releaseHeld(pitch);
  }

  async function previewNote(pitch: number, velocity: number): Promise<void> {
    const h = await options.ensureEngineStarted();
    if (!h) return;
    const activeTrack = store.tracks.find((track) => track.id === store.activeTrackId);
    if (activeTrack && activeTrack.kind === 'midi' && options.hasMidiSync()) {
      const durationMs = (PREVIEW_DURATION_PPQ * 60000) / Math.max(1, store.tempoBpm);
      try {
        h.engine.pushMidiNoteOn(activeTrack.id, 0, 0, pitch, velocity);
        setTimeout(() => {
          try {
            h.engine.pushMidiNoteOff(activeTrack.id, 0, 0, pitch);
          } catch {
            // The engine may be disposed before the note-off timer fires.
          }
        }, durationMs);
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

  return {
    auditionNote,
    previewNote,
    previewNoteOn,
    previewNoteOff,
    releaseAll,
  };
}

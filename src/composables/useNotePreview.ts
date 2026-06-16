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

export interface NotePreviewOptions {
  errorMessage: Ref<string>;
  handle: ShallowRef<EngineHandle | null>;
  hasMidiSync: () => boolean;
  ensureEngineStarted: () => Promise<EngineHandle | null>;
}

export function useNotePreview(options: NotePreviewOptions) {
  const store = useProjectStore();

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
  };
}

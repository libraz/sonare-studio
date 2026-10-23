import { describe, expect, it } from 'vitest';
import type { LoadedAudioAsset } from '@/persistence/assets';
import { MAX_POLYPHONIC_SECONDS, transcribeAudioClip } from '@/project/audio-transcription';
import type { TranscribeResult } from '@/wasm/index.js';

const RATE = 1_000;
const SECONDS = 2 * MAX_POLYPHONIC_SECONDS + 10;

function noteEvent(ppq: number, status: 0x8 | 0x9, pitch: number) {
  return {
    ppq,
    data0: (0x20000000 | (status << 20) | (pitch << 8) | (status === 0x9 ? 90 : 0)) >>> 0,
    data1: 0,
  };
}

/** A mono source whose sample value is its frame index, so a chunk reveals where it starts. */
function source(): LoadedAudioAsset {
  const frames = SECONDS * RATE;
  return {
    meta: { id: 'long', name: 'long', sampleRate: RATE, numChannels: 1, numFrames: frames },
    channels: [Float32Array.from({ length: frames }, (_, frame) => frame)],
  };
}

interface HeldNote {
  onset: number;
  release: number;
  pitch: number;
}

/** Reads held notes as a detector does: clipped to the buffer, closed at its end. */
async function transcribeHeld(held: HeldNote[]) {
  const { notes } = await transcribeAudioClip(
    { assetId: 'long', startPpq: 0, lengthPpq: SECONDS, sourceOffsetPpq: 0 },
    60,
    {
      loadAudioAsset: async () => source(),
      transcribe: async (samples) => {
        const from = samples[0] / RATE;
        const to = from + samples.length / RATE;
        const events = held
          .filter((note) => note.release > from && note.onset < to)
          .flatMap((note) => [
            noteEvent(Math.max(note.onset, from) - from, 0x9, note.pitch),
            noteEvent(Math.min(note.release, to) - from, 0x8, note.pitch),
          ]);
        const result: TranscribeResult = {
          events,
          noteCount: events.length / 2,
          tempoBpm: 60,
          tuning: 0,
        };
        return result;
      },
    },
    { polyphonic: true },
  );
  return { notes };
}

describe('polyphonic chunk seams', () => {
  it('keeps a note held across a chunk cut as one note of its full length', async () => {
    const cutAt = SECONDS / Math.ceil(SECONDS / (MAX_POLYPHONIC_SECONDS - 4));
    const onset = cutAt - 1;
    const { notes } = await transcribeHeld([{ onset, release: onset + 10, pitch: 60 }]);
    expect(notes).toHaveLength(1);
    expect(notes[0].startPpq).toBeCloseTo(onset, 3);
    expect(notes[0].durationPpq).toBeCloseTo(10, 3);
  });

  it('chains a note held across two cuts and leaves a same-pitch restrike alone', async () => {
    const cutAt = SECONDS / Math.ceil(SECONDS / (MAX_POLYPHONIC_SECONDS - 4));
    const { notes } = await transcribeHeld([
      { onset: cutAt - 1, release: 2 * cutAt + 10, pitch: 60 },
      { onset: 20, release: 21, pitch: 60 },
      { onset: cutAt + 20, release: cutAt + 21, pitch: 64 },
    ]);
    const long = notes.filter((note) => note.pitch === 60 && note.durationPpq > 2);
    expect(long).toHaveLength(1);
    expect(long[0].durationPpq).toBeCloseTo(cutAt + 11, 3);
    expect(notes).toHaveLength(3);
  });
});

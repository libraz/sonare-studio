import { describe, expect, it } from 'vitest';
import { DEFAULT_MIDI_FX_CONFIG } from '@/project/midi-fx';
import type { EditorTrack } from '@/project/types';
import { scoreOmitsMidiFx } from '@/ui/score/midi-fx-notice';

function track(overrides: Partial<EditorTrack> = {}): EditorTrack {
  return {
    id: 1,
    name: 'Track 1',
    color: '#60a5fa',
    kind: 'midi',
    mute: false,
    solo: false,
    volume: 1,
    pan: 0,
    order: 0,
    ...overrides,
  };
}

describe('scoreOmitsMidiFx', () => {
  it('is false when the active track has no effective MIDI-FX', () => {
    expect(scoreOmitsMidiFx(null)).toBe(false);
    expect(scoreOmitsMidiFx(track())).toBe(false);
    expect(scoreOmitsMidiFx(track({ midiFx: { ...DEFAULT_MIDI_FX_CONFIG } }))).toBe(false);
  });

  it('is true for effective MIDI-FX on a MIDI track only', () => {
    const midiFx = { ...DEFAULT_MIDI_FX_CONFIG, transposeSemitones: 12 };
    expect(scoreOmitsMidiFx(track({ midiFx }))).toBe(true);
    expect(scoreOmitsMidiFx(track({ kind: 'audio', midiFx }))).toBe(false);
  });
});

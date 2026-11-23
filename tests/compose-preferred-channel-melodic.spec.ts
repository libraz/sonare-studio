import { describe, expect, it } from 'vitest';
import { GM_PERCUSSION_CHANNEL, preferredNoteChannel } from '@/compose/tracks';
import type { EditorNote, EditorTrack } from '@/project/types';

function track(partial: Partial<EditorTrack> = {}): EditorTrack {
  return {
    id: 1,
    name: 'Lead',
    color: '#fff',
    kind: 'midi',
    mute: false,
    solo: false,
    volume: 1,
    pan: 0,
    order: 0,
    ...partial,
  };
}

function notes(channels: number[]): EditorNote[] {
  return channels.map((channel, index) => ({
    id: index + 1,
    pitch: 60,
    velocity: 96,
    startPpq: index,
    durationPpq: 1,
    channel,
  }));
}

describe('preferredNoteChannel on a melodic track', () => {
  it('never picks the percussion channel for an explicitly melodic track', () => {
    expect(preferredNoteChannel(track({ percussion: false }), notes([9, 9, 9, 2]))).toBe(2);
    expect(preferredNoteChannel(track({ percussion: false }), notes([9, 9]))).toBe(0);
  });

  it('skips a percussion plurality below the drum-track threshold', () => {
    const picked = preferredNoteChannel(track(), notes([9, 9, 0, 1]));
    expect(picked).not.toBe(GM_PERCUSSION_CHANNEL);
    expect(picked).toBe(0);
  });
});

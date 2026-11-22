import { describe, expect, it } from 'vitest';
import { isDrumTrack, preferredNoteChannel } from '@/compose/tracks';
import type { EditorNote, EditorTrack } from '@/project/types';

function track(partial: Partial<EditorTrack> = {}): EditorTrack {
  return {
    id: 1,
    name: 'Imported Part',
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

function note(channel: number): EditorNote {
  return {
    id: channel + 1,
    pitch: 60,
    velocity: 96,
    startPpq: 0,
    durationPpq: 1,
    channel,
  };
}

describe('percussion channel safety', () => {
  it('recognizes an imported channel-10 part and keeps new notes on channel 10', () => {
    const imported = track();
    const notes = [note(9), note(9), note(0)];

    expect(isDrumTrack(imported, notes)).toBe(true);
    expect(preferredNoteChannel(imported, notes)).toBe(9);
  });

  it('recognizes drum-kit and GM2 drum-bank instruments even without notes', () => {
    expect(isDrumTrack(track({ instrument: { kind: 'synth-preset', preset: 'drumKit' } }))).toBe(
      true,
    );
    expect(
      isDrumTrack(
        track({
          instrument: {
            kind: 'synth-preset',
            preset: 'ePiano',
            useGmPrograms: true,
            gmBank: 120 << 7,
          },
        }),
      ),
    ).toBe(true);
    expect(
      isDrumTrack(
        track({
          instrument: { kind: 'sf2', fontId: 'font', bank: 120 << 7 },
        }),
      ),
    ).toBe(true);
  });

  it('does not turn a mixed SF2 channel map into an all-drum track', () => {
    const mixed = track({
      instrument: {
        kind: 'sf2',
        fontId: 'font',
        channelMap: [
          { channel: 0, bank: 0, program: 40 },
          { channel: 9, bank: 120 << 7, program: 0 },
        ],
      },
    });
    expect(isDrumTrack(mixed, [note(0), note(0), note(9)])).toBe(false);
    expect(preferredNoteChannel(mixed, [note(0), note(0), note(9)])).toBe(0);
  });

  it('lets an explicit melodic override win over drum heuristics', () => {
    const melodic = track({ percussion: false });
    const notes = [note(0), note(0), note(9)];

    expect(isDrumTrack(melodic, notes)).toBe(false);
    expect(preferredNoteChannel(melodic, notes)).toBe(0);
  });

  it('retains the modal melodic channel and chooses the lower channel on a tie', () => {
    const melodic = track();
    expect(preferredNoteChannel(melodic, [note(3), note(3), note(5)])).toBe(3);
    expect(preferredNoteChannel(melodic, [note(5), note(3)])).toBe(3);
    expect(preferredNoteChannel(melodic, [])).toBe(0);
  });
});

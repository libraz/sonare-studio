import { describe, expect, it, vi } from 'vitest';
import type { EngineHandle } from '@/engine/engine';
import { createMidiSync } from '@/engine/midi-sync';
import type { EditorClip, EditorTrack, TempoSegment } from '@/project/types';

const TEMPO_120: TempoSegment[] = [{ startPpq: 0, bpm: 120 }];

/** UMP MIDI 1.0 control-change word. */
function ccWord(channel: number, controller: number, value: number): number {
  return (0x2 << 28) | (0xb << 20) | (channel << 16) | (controller << 8) | value;
}

function makeHandle() {
  const engine = {
    setMidiClips: vi.fn(),
    pushMidiUmp: vi.fn(),
    setSynthInstrument: vi.fn(),
    loadSoundFont: vi.fn(),
    setSf2Instrument: vi.fn(),
    pushMidiSysex: vi.fn(),
    clearMidiFx: vi.fn(),
    setMidiFx: vi.fn(),
    setMidiDestinationExternal: vi.fn(),
    setExternalMidiClockEnabled: vi.fn(),
  };
  const handle = { ctx: { sampleRate: 48000 }, engine } as unknown as EngineHandle;
  return { handle, engine };
}

const track: EditorTrack = {
  id: 1,
  name: 'Strings',
  color: '#60a5fa',
  kind: 'midi',
  mute: false,
  solo: false,
  volume: 1,
  pan: 0,
  order: 1,
  instrument: { kind: 'synth-preset', preset: 'saw-lead' },
  expressionMap: { entries: [{ articulation: 'staccato', controller: 32, value: 5 }] },
};

function makeClip(): EditorClip {
  return {
    id: 1,
    trackId: 1,
    name: 'Clip',
    startPpq: 0,
    lengthPpq: 4,
    sourceOffsetPpq: 0,
    gain: 1,
    loopEnabled: false,
    loopLengthPpq: 0,
    notes: [{ id: 7, pitch: 60, velocity: 100, startPpq: 1, durationPpq: 1, channel: 0 }],
    ccLanes: [{ controller: 11, channel: 0, points: [{ ppq: 0, value: 90 }] }],
  };
}

describe('MIDI seek state', () => {
  it('replays articulation-driven controllers that sync scheduled', async () => {
    const { handle, engine } = makeHandle();
    const sync = createMidiSync(handle, { loadFont: async () => new Uint8Array([1]) });
    const articulations = new Map([[1, new Map([[7, 'staccato' as const]])]]);

    await sync.sync([track], [makeClip()], TEMPO_120, null, articulations);
    sync.restoreStateAtPpq(3, 100);

    expect(engine.pushMidiUmp).toHaveBeenCalledWith(1, ccWord(0, 32, 5), 100);
    expect(engine.pushMidiUmp).toHaveBeenCalledWith(1, ccWord(0, 11, 90), 100);
  });

  it('reads the schedules compiled by sync instead of recompiling the project', async () => {
    const { handle, engine } = makeHandle();
    const sync = createMidiSync(handle, { loadFont: async () => new Uint8Array([1]) });
    const clip = makeClip();

    await sync.sync([track], [clip], TEMPO_120);
    // An in-place change sync has not seen cannot reach a seek that replays the compiled plan.
    clip.ccLanes = [{ controller: 11, channel: 0, points: [{ ppq: 0, value: 10 }] }];
    sync.restoreStateAtPpq(3, 100);

    expect(engine.pushMidiUmp).toHaveBeenCalledWith(1, ccWord(0, 11, 90), 100);
    expect(engine.pushMidiUmp).not.toHaveBeenCalledWith(1, ccWord(0, 11, 10), 100);
  });
});

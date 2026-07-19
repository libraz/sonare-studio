import { describe, expect, it } from 'vitest';
import { MAX_LANE_METER_TARGETS } from '@/engine/meter-targets';
import {
  busParamId,
  ENGINE_MIXER_PARAM_FADER_DB,
  laneParamId,
  masterParamId,
} from '@/export/engine-render-types';
import type { TrackInstrument } from '@/project/instrument';
import {
  evaluateProjectCapacity,
  formatProjectCapacityIssue,
  MAX_INTERNAL_MIDI_INSTRUMENTS,
  MAX_METERED_MIXER_LANES,
  MAX_MIXER_PARAM_LANES,
  type ProjectCapacityStrings,
} from '@/project/project-capacity';
import type { EditorTrack } from '@/project/types';

/** A minimal MIDI track carrying only the fields the capacity check reads. */
function midiTrack(instrument?: TrackInstrument, extra: Partial<EditorTrack> = {}): EditorTrack {
  return { kind: 'midi', instrument, ...extra } as EditorTrack;
}

/** N MIDI tracks each with a distinct synth preset (distinct instruments). */
function distinctMidiTracks(n: number): EditorTrack[] {
  return Array.from({ length: n }, (_, i) =>
    midiTrack({ kind: 'synth-preset', preset: `preset-${i}` }),
  );
}

/**
 * N MIDI tracks that all share one instrument, so they exercise the mixer-lane
 * count without ever tripping the internal-instrument budget (every track past
 * the first reuses the same destination).
 */
function sharedMidiTracks(n: number): EditorTrack[] {
  return Array.from({ length: n }, () => midiTrack({ kind: 'synth-preset', preset: 'shared' }));
}

const STRINGS: ProjectCapacityStrings = {
  mixerLaneMeters: 'meters {lanes}/{limit}',
  mixerLaneParamId: 'paramid {lanes}/{limit}',
  internalMidiInstruments: 'instruments {tracks}/{limit}',
};

describe('evaluateProjectCapacity', () => {
  it('reports nothing for a project within every budget', () => {
    expect(evaluateProjectCapacity(distinctMidiTracks(10))).toEqual([]);
  });

  it('warns once mixer lanes exceed the meter target range but not at the boundary', () => {
    // Exactly at the limit is still fine; one past it loses meters on the tail.
    expect(evaluateProjectCapacity(sharedMidiTracks(MAX_METERED_MIXER_LANES))).toEqual([]);
    const issues = evaluateProjectCapacity(sharedMidiTracks(MAX_METERED_MIXER_LANES + 1));
    expect(issues).toContainEqual({
      kind: 'mixer-lane-meters',
      lanes: MAX_METERED_MIXER_LANES + 1,
      limit: MAX_METERED_MIXER_LANES,
    });
  });

  it('warns about parameter-id collision once lanes pass the param-id ceiling', () => {
    expect(evaluateProjectCapacity(sharedMidiTracks(MAX_MIXER_PARAM_LANES))).not.toContainEqual(
      expect.objectContaining({ kind: 'mixer-lane-param-id' }),
    );
    const issues = evaluateProjectCapacity(sharedMidiTracks(MAX_MIXER_PARAM_LANES + 1));
    expect(issues).toContainEqual({
      kind: 'mixer-lane-param-id',
      lanes: MAX_MIXER_PARAM_LANES + 1,
      limit: MAX_MIXER_PARAM_LANES,
    });
  });

  it('warns when more distinct internal instruments than destinations are used', () => {
    // Exactly the limit fits; the next distinct-instrument track overflows.
    expect(
      evaluateProjectCapacity(distinctMidiTracks(MAX_INTERNAL_MIDI_INSTRUMENTS)),
    ).not.toContainEqual(expect.objectContaining({ kind: 'internal-midi-instruments' }));
    const issues = evaluateProjectCapacity(distinctMidiTracks(MAX_INTERNAL_MIDI_INSTRUMENTS + 2));
    expect(issues).toContainEqual({
      kind: 'internal-midi-instruments',
      overflowTracks: 2,
      limit: MAX_INTERNAL_MIDI_INSTRUMENTS,
    });
  });

  it('does not count tracks that reuse an already-assigned instrument as overflow', () => {
    // 16 slots consumed by distinct presets, then many tracks sharing one of
    // those presets: they reuse a destination, so nothing is misrouted.
    const tracks = [
      ...distinctMidiTracks(MAX_INTERNAL_MIDI_INSTRUMENTS),
      ...Array.from({ length: 20 }, () => midiTrack({ kind: 'synth-preset', preset: 'preset-0' })),
    ];
    expect(evaluateProjectCapacity(tracks)).not.toContainEqual(
      expect.objectContaining({ kind: 'internal-midi-instruments' }),
    );
  });

  it('ignores external-MIDI and frozen tracks for the instrument budget', () => {
    const tracks = [
      ...Array.from({ length: 30 }, () =>
        midiTrack({ kind: 'external-midi', outputPortId: 'p', channel: 0 }),
      ),
      ...Array.from({ length: 30 }, (_, i) =>
        midiTrack({ kind: 'synth-preset', preset: `frozen-${i}` }, { frozen: {} as never }),
      ),
    ];
    expect(evaluateProjectCapacity(tracks)).not.toContainEqual(
      expect.objectContaining({ kind: 'internal-midi-instruments' }),
    );
  });
});

describe('formatProjectCapacityIssue', () => {
  it('fills the templates for every issue kind', () => {
    expect(
      formatProjectCapacityIssue({ kind: 'mixer-lane-meters', lanes: 40, limit: 32 }, STRINGS),
    ).toBe('meters 40/32');
    expect(
      formatProjectCapacityIssue({ kind: 'mixer-lane-param-id', lanes: 300, limit: 253 }, STRINGS),
    ).toBe('paramid 300/253');
    expect(
      formatProjectCapacityIssue(
        { kind: 'internal-midi-instruments', overflowTracks: 3, limit: 16 },
        STRINGS,
      ),
    ).toBe('instruments 3/16');
  });
});

describe('capacity thresholds stay locked to the engine id spaces', () => {
  it('mirrors the per-lane meter target count', () => {
    expect(MAX_METERED_MIXER_LANES).toBe(MAX_LANE_METER_TARGETS);
  });

  it('marks the first lane index that collides with a reserved param id', () => {
    // Indices below the ceiling never alias a bus or the master strip...
    const fader = ENGINE_MIXER_PARAM_FADER_DB;
    const reserved = new Set([masterParamId(fader), busParamId(1, fader)]);
    for (let index = 0; index < MAX_MIXER_PARAM_LANES; index++) {
      expect(reserved.has(laneParamId(index, fader))).toBe(false);
    }
    // ...but the ceiling index itself collides with the first bus lane.
    expect(laneParamId(MAX_MIXER_PARAM_LANES, fader)).toBe(busParamId(1, fader));
  });
});

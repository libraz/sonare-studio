import { describe, expect, it } from 'vitest';
import { buildMixerSnapshot, mergeMixerSnapshot } from '@/project/command/mixer';
import { createDefaultStrip, type MixerStrip, type ProjectMixerState } from '@/project/mixer';
import type { EditorTrack } from '@/project/types';

function strip(over: Partial<MixerStrip> = {}): MixerStrip {
  return { ...createDefaultStrip(), ...over };
}

function track(id: number, over: Partial<EditorTrack> = {}): EditorTrack {
  return {
    id,
    name: `T${id}`,
    color: '#888',
    kind: 'midi',
    mute: false,
    solo: false,
    volume: 1,
    pan: 0,
    order: id,
    ...over,
  };
}

function mixer(over: Partial<ProjectMixerState> = {}): ProjectMixerState {
  return { master: createDefaultStrip(), buses: [], ...over };
}

describe('buildMixerSnapshot', () => {
  it('captures the mixer state and per-track strip/flags, deep-copied', () => {
    const source = mixer({ master: strip({ gainDb: -3 }) });
    const tracks = [
      track(1, { mixer: strip({ gainDb: 2 }), mute: true, solo: true, soloSafe: true }),
    ];
    const snap = buildMixerSnapshot(source, tracks);

    expect(snap.mixer.master.gainDb).toBe(-3);
    expect(snap.tracks).toHaveLength(1);
    expect(snap.tracks[0]).toMatchObject({ id: 1, mute: true, solo: true, soloSafe: true });
    expect(snap.tracks[0].mixer.gainDb).toBe(2);

    // Deep copy: mutating the source does not change the snapshot.
    source.master.gainDb = 10;
    tracks[0].mixer!.gainDb = 99;
    expect(snap.mixer.master.gainDb).toBe(-3);
    expect(snap.tracks[0].mixer.gainDb).toBe(2);
  });

  it('omits soloSafe/vcaId when the track does not carry them, defaults strip', () => {
    const snap = buildMixerSnapshot(mixer(), [track(1)]);
    expect(snap.tracks[0].soloSafe).toBeUndefined();
    expect(snap.tracks[0].vcaId).toBeUndefined();
    expect(snap.tracks[0].mixer).toEqual(createDefaultStrip());
  });
});

describe('mergeMixerSnapshot', () => {
  it('restores the master strip and existing tracks strip/flags', () => {
    const snap = buildMixerSnapshot(mixer({ master: strip({ gainDb: -6 }) }), [
      track(1, { mixer: strip({ gainDb: 4, pan: 0.5 }), mute: true }),
    ]);
    const current = [track(1, { mixer: strip({ gainDb: 0 }), mute: false })];
    const { mixer: nextMixer, tracks } = mergeMixerSnapshot(snap, current);

    expect(nextMixer.master.gainDb).toBe(-6);
    expect(tracks[0].mixer?.gainDb).toBe(4);
    expect(tracks[0].mixer?.pan).toBe(0.5);
    expect(tracks[0].mute).toBe(true);
  });

  it('leaves tracks added after the snapshot untouched (but routing-sanitized)', () => {
    const snap = buildMixerSnapshot(mixer(), [track(1)]);
    const current = [track(1), track(2, { mixer: strip({ gainDb: 7 }) })];
    const { tracks } = mergeMixerSnapshot(snap, current);
    expect(tracks).toHaveLength(2);
    expect(tracks[1].mixer?.gainDb).toBe(7);
  });

  it('ignores snapshot tracks that no longer exist', () => {
    const snap = buildMixerSnapshot(mixer(), [track(1), track(99, { mute: true })]);
    const { tracks } = mergeMixerSnapshot(snap, [track(1)]);
    expect(tracks.map((entry) => entry.id)).toEqual([1]);
  });

  it('drops sends and output routing to buses missing from the restored mixer', () => {
    // Snapshot restores a mixer with only bus 'b1'; the track routed to 'b2'.
    const snap = buildMixerSnapshot(mixer({ buses: [{ id: 'b1', name: 'B1', gainDb: 0 }] }), [
      track(1, {
        mixer: strip({
          outputBusId: 'b2',
          sends: [
            { busId: 'b1', levelDb: -6, enabled: true },
            { busId: 'b2', levelDb: -3, enabled: true },
          ],
        }),
      }),
    ]);
    const { tracks } = mergeMixerSnapshot(snap, [track(1)]);
    expect(tracks[0].mixer?.outputBusId).toBeUndefined();
    expect(tracks[0].mixer?.sends.map((s) => s.busId)).toEqual(['b1']);
  });

  it('drops VCA membership pointing at a group missing from the restored mixer', () => {
    const snap = buildMixerSnapshot(mixer(), [track(1, { vcaId: 'vca-9' })]);
    const { tracks } = mergeMixerSnapshot(snap, [track(1)]);
    expect(tracks[0].vcaId).toBeUndefined();
  });

  it('restores VCA membership when the group exists in the restored mixer', () => {
    const snap = buildMixerSnapshot(
      mixer({ vcaGroups: [{ id: 'vca-1', name: 'VCA 1', gainDb: 0 }] }),
      [track(1, { vcaId: 'vca-1' })],
    );
    const { tracks } = mergeMixerSnapshot(snap, [track(1, { vcaId: undefined })]);
    expect(tracks[0].vcaId).toBe('vca-1');
  });
});

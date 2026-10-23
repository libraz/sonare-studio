import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureWasm } from '@/lib/wasm';
import { addVcaGroup, setTrackVca, setVcaGroupGain } from '@/project/command/mixer-vca';
import { addNote, clearHistory, setTrackPan, setTrackVolume } from '@/project/commands';
import { exportClipSmf } from '@/project/export';
import type { ProjectDocument } from '@/project/serialization';
import { gmVolumeCc, projectDocumentToSmfWithLoss } from '@/project/smf';
import { useProjectStore } from '@/project/store';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

interface Event {
  ppq: number;
  status: number;
  channel: number;
  d1: number;
  d2: number;
}

function decode(events: ReadonlyArray<{ ppq: number; data0: number }>): Event[] {
  return events.map((e) => ({
    ppq: e.ppq,
    status: (e.data0 >> 20) & 0xf,
    channel: (e.data0 >> 16) & 0xf,
    d1: (e.data0 >> 8) & 0xff,
    d2: e.data0 & 0xff,
  }));
}

/** Runs the callback and returns the events written to the SMF track. */
async function capture(run: () => Promise<unknown>): Promise<Event[]> {
  const wasm = await ensureWasm();
  const spy = vi.spyOn(wasm.Project.prototype, 'setMidiEvents');
  try {
    await run();
    return decode(spy.mock.lastCall?.[1] ?? []);
  } finally {
    spy.mockRestore();
  }
}

type DocTrack = ProjectDocument['tracks'][number];

function docWith(track: DocTrack, extra: Partial<ProjectDocument> = {}): ProjectDocument {
  return {
    schemaVersion: 3,
    name: 'Setup',
    sampleRate: 48000,
    tempoSegments: [{ startPpq: 0, bpm: 120 }],
    timeSignatures: [{ startPpq: 0, numerator: 4, denominator: 4 }],
    tracks: [track],
    markers: [],
    sections: [],
    ...extra,
  };
}

function track(overrides: Partial<DocTrack>, channels: number[], ccLanes?: unknown): DocTrack {
  return {
    name: 'T',
    color: '#000',
    kind: 'midi',
    mute: false,
    solo: false,
    volume: 1,
    pan: 0,
    clips: [
      {
        name: 'c',
        startPpq: 0,
        lengthPpq: 4,
        sourceOffsetPpq: 0,
        gain: 1,
        loopEnabled: false,
        loopLengthPpq: 0,
        kind: 'midi',
        notes: channels.map((channel, index) => ({
          pitch: 60 + index,
          velocity: 100,
          startPpq: index,
          durationPpq: 1,
          channel,
        })),
        ...(ccLanes ? { ccLanes: ccLanes as never } : {}),
      },
    ],
    ...overrides,
  };
}

const ccs = (events: Event[], controller: number): Event[] =>
  events.filter((e) => e.status === 0xb && e.d1 === controller);

describe('SMF track setup', () => {
  it('writes each SF2 channel from its map entry and nothing for unselected channels', async () => {
    const doc = docWith(
      track(
        {
          instrument: {
            kind: 'sf2',
            fontId: 'f',
            channelMap: [
              { channel: 9, bank: 15360 },
              { channel: 0, program: 33 },
            ],
          },
        },
        [0, 9, 3],
      ),
    );
    const events = await capture(() => projectDocumentToSmfWithLoss(doc));
    const setup = events.filter(
      (e) => e.ppq === 0 && (e.status === 0xc || e.d1 === 0 || e.d1 === 32),
    );
    expect(setup.filter((e) => e.channel === 0 && e.status === 0xc).map((e) => e.d1)).toEqual([33]);
    expect(setup.filter((e) => e.channel === 0 && e.status === 0xb)).toEqual([]);
    expect(
      ccs(events, 0)
        .filter((e) => e.channel === 9)
        .map((e) => e.d2),
    ).toEqual([120]);
    expect(
      ccs(events, 32)
        .filter((e) => e.channel === 9)
        .map((e) => e.d2),
    ).toEqual([0]);
    expect(events.filter((e) => e.status === 0xc && e.channel === 3)).toEqual([]);
  });

  it('writes an external-MIDI track on its transmit channel', async () => {
    const doc = docWith(
      track({ instrument: { kind: 'external-midi', outputPortId: 'p', channel: 5 } }, [0, 2]),
    );
    const events = await capture(() => projectDocumentToSmfWithLoss(doc));
    const notes = events.filter((e) => e.status === 0x9);
    expect(notes.length).toBe(2);
    expect(new Set(notes.map((e) => e.channel))).toEqual(new Set([5]));
  });

  it('stacks the static fader and pan on clip CC7 and CC10 lanes', async () => {
    const lanes = [
      { channel: 0, controller: 7, points: [{ ppq: 0, value: 100 }] },
      { channel: 0, controller: 10, points: [{ ppq: 1, value: 64 }] },
    ];
    const doc = docWith(track({ volume: 0.25, pan: -1 }, [0], lanes));
    const events = await capture(() => projectDocumentToSmfWithLoss(doc));
    const volumes = ccs(events, 7).map((e) => e.d2);
    expect(volumes[volumes.length - 1]).toBe(Math.round(100 * (gmVolumeCc(0.25) / 127)));
    expect(volumes[volumes.length - 1]).toBeLessThan(100);
    const pans = ccs(events, 10).map((e) => e.d2);
    expect(pans[pans.length - 1]).toBe(Math.max(0, Math.round(64 - 63.5)));
  });
});

describe('single-clip SMF export', () => {
  let store: ReturnType<typeof useProjectStore>;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
  });

  it('writes the same CC7/CC10 setup as the whole-project export of the track', async () => {
    addNote({ pitch: 60, startPpq: 0, durationPpq: 1 });
    setTrackVolume(store.activeTrackId, 0.5);
    setTrackPan(store.activeTrackId, -1);
    const events = await capture(() => exportClipSmf(store.clipId));
    expect(ccs(events, 7).map((e) => e.d2)).toEqual([gmVolumeCc(0.5)]);
    expect(ccs(events, 10).map((e) => e.d2)).toEqual([0]);
  });

  it('carries the VCA offset of the track group', async () => {
    addNote({ pitch: 60, startPpq: 0, durationPpq: 1 });
    const groupId = addVcaGroup();
    setVcaGroupGain(groupId, -6);
    setTrackVca(store.activeTrackId, groupId);
    const events = await capture(() => exportClipSmf(store.clipId));
    expect(ccs(events, 7).map((e) => e.d2)).toEqual([gmVolumeCc(10 ** (-6 / 20))]);
  });
});

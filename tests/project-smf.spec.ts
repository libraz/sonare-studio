import { describe, expect, it, vi } from 'vitest';
import type { ProjectDocument } from '@/project/serialization';
import { projectDocumentToSmf, smfToProjectDocument } from '@/project/smf';

vi.mock('@/lib/wasm', async () => {
  const [wasm, fs] = await Promise.all([import('@/wasm/index.js'), import('node:fs')]);
  let module: typeof wasm | null = null;
  return {
    ensureWasm: async () => {
      if (!module) {
        const wasmBinary = fs.readFileSync(`${process.cwd()}/src/wasm/sonare.wasm`);
        await wasm.init({ wasmBinary } as Parameters<typeof wasm.init>[0]);
        module = wasm;
      }
      return module;
    },
  };
});

function ascii(text: string): number[] {
  return [...text].map((char) => char.charCodeAt(0));
}

function u16(value: number): number[] {
  return [(value >> 8) & 0xff, value & 0xff];
}

function u32(value: number): number[] {
  return [(value >> 24) & 0xff, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

function varLen(value: number): number[] {
  let buffer = value & 0x7f;
  const bytes = [buffer];
  value >>= 7;
  while (value > 0) {
    buffer = (value & 0x7f) | 0x80;
    bytes.unshift(buffer);
    value >>= 7;
  }
  return bytes;
}

function chunk(type: string, data: number[]): number[] {
  return [...ascii(type), ...u32(data.length), ...data];
}

function smf(format: number, ticksPerQuarter: number, tracks: number[][]): Uint8Array {
  return new Uint8Array([
    ...chunk('MThd', [...u16(format), ...u16(tracks.length), ...u16(ticksPerQuarter)]),
    ...tracks.flatMap((track) => chunk('MTrk', track)),
  ]);
}

function meta(delta: number, type: number, data: number[]): number[] {
  return [...varLen(delta), 0xff, type, ...varLen(data.length), ...data];
}

function eot(delta = 0): number[] {
  return meta(delta, 0x2f, []);
}

describe('smfToProjectDocument', () => {
  it('imports format 1 tracks with tempo, meter, notes and CC lanes', async () => {
    const bytes = smf(1, 480, [
      [
        ...meta(0, 0x51, [0x07, 0xa1, 0x20]), // 120 BPM
        ...meta(0, 0x58, [3, 2, 24, 8]), // 3/4
        ...eot(),
      ],
      [
        ...meta(0, 0x03, ascii('Piano')),
        ...varLen(0),
        0xc1,
        38,
        ...varLen(0),
        0xb1,
        1,
        64,
        ...varLen(0),
        0xe1,
        0,
        96,
        ...varLen(0),
        0xd1,
        70,
        ...varLen(0),
        0xa1,
        60,
        80,
        ...varLen(0),
        0x91,
        60,
        100,
        ...varLen(240),
        0x81,
        60,
        32,
        ...eot(),
      ],
    ]);

    const doc = await smfToProjectDocument(bytes, 'song.mid');

    expect(doc.name).toBe('song');
    expect(doc.tempoSegments).toEqual([{ startPpq: 0, bpm: 120 }]);
    expect(doc.timeSignatures).toEqual([{ startPpq: 0, numerator: 3, denominator: 4 }]);
    expect(doc.tracks).toHaveLength(1);
    expect(doc.tracks[0].name).toBe('Piano');
    expect(doc.tracks[0].instrument).toEqual({
      kind: 'synth-preset',
      preset: 'sub-bass',
      gmProgram: 38,
    });
    expect(doc.tracks[0].clips[0].notes).toEqual([
      {
        pitch: 60,
        velocity: 100,
        startPpq: 0,
        durationPpq: 0.5,
        channel: 1,
        offVelocity: 32,
      },
    ]);
    expect(doc.tracks[0].clips[0].ccLanes).toEqual([
      { controller: 1, channel: 1, points: [{ ppq: 0, value: 64 }] },
    ]);
    expect(doc.tracks[0].clips[0].pitchBendLanes).toEqual([
      { channel: 1, points: [{ ppq: 0, value: 12288 }] },
    ]);
    expect(doc.tracks[0].clips[0].programChangeLanes).toEqual([
      { channel: 1, points: [{ ppq: 0, program: 38 }] },
    ]);
    expect(doc.tracks[0].clips[0].channelPressureLanes).toEqual([
      { channel: 1, points: [{ ppq: 0, value: 70 }] },
    ]);
    expect(doc.tracks[0].clips[0].polyPressureLanes).toEqual([
      { channel: 1, pitch: 60, points: [{ ppq: 0, value: 80 }] },
    ]);
  });

  it('imports format 0 notes using running status', async () => {
    const bytes = smf(0, 96, [[...varLen(0), 0x90, 64, 90, ...varLen(96), 64, 0, ...eot()]]);

    const doc = await smfToProjectDocument(bytes, 'riff.midi');

    expect(doc.tracks).toHaveLength(1);
    expect(doc.tracks[0].clips[0].notes).toEqual([
      { pitch: 64, velocity: 90, startPpq: 0, durationPpq: 1, channel: 0 },
    ]);
  });

  it('keeps an imported MIDI track with an empty clip', async () => {
    const bytes = smf(1, 480, [
      [...meta(0, 0x51, [0x07, 0xa1, 0x20]), ...eot()],
      [...meta(0, 0x03, ascii('Empty Pad')), ...eot()],
    ]);

    const doc = await smfToProjectDocument(bytes, 'empty.mid');

    expect(doc.tracks).toHaveLength(1);
    expect(doc.tracks[0].clips).toHaveLength(1);
    expect(doc.tracks[0].clips[0].notes).toEqual([]);
  });

  it('imports timeline meta events as markers', async () => {
    const bytes = smf(1, 480, [
      [
        ...meta(0, 0x06, ascii('Verse')),
        ...meta(240, 0x05, ascii('hello')),
        ...meta(0, 0x07, ascii('hit')),
        ...meta(0, 0x01, ascii('note')),
        ...meta(0, 0x59, [0, 0]),
        ...eot(),
      ],
      [...varLen(0), 0x90, 60, 100, ...varLen(240), 0x80, 60, 0, ...eot()],
    ]);

    const doc = await smfToProjectDocument(bytes, 'meta.mid');

    expect(doc.markers).toEqual([
      { ppq: 0, name: 'Verse' },
      { ppq: 0.5, name: 'Cue: hit' },
      { ppq: 0.5, name: 'Key: C major' },
      { ppq: 0.5, name: 'Lyric: hello' },
      { ppq: 0.5, name: 'Text: note' },
    ]);
  });

  it('splits mixed format 0 channels and programs into separate tracks', async () => {
    const bytes = smf(0, 480, [
      [
        ...varLen(0),
        0xc0,
        0,
        ...varLen(0),
        0xc1,
        38,
        ...varLen(0),
        0x90,
        60,
        100,
        ...varLen(0),
        0x91,
        36,
        100,
        ...varLen(0),
        0x99,
        36,
        100,
        ...varLen(480),
        0x80,
        60,
        0,
        ...varLen(0),
        0x81,
        36,
        0,
        ...varLen(0),
        0x89,
        36,
        0,
        ...eot(),
      ],
    ]);

    const doc = await smfToProjectDocument(bytes, 'gm.mid');

    expect(doc.tracks).toHaveLength(3);
    expect(doc.tracks.map((track) => track.instrument)).toEqual([
      { kind: 'synth-preset', preset: 'acoustic-piano', gmProgram: 0 },
      { kind: 'synth-preset', preset: 'sub-bass', gmProgram: 38 },
      { kind: 'synth-preset', preset: 'drum-kit', gmProgram: 0 },
    ]);
    expect(doc.tracks.map((track) => track.clips[0].notes[0].channel)).toEqual([0, 1, 9]);
  });

  it('keeps notes sustained across program changes in their note-on group', async () => {
    const bytes = smf(0, 480, [
      [
        ...varLen(0),
        0xc0,
        0,
        ...varLen(0),
        0x90,
        60,
        100,
        ...varLen(240),
        0xc0,
        38,
        ...varLen(240),
        0x80,
        60,
        0,
        ...varLen(0),
        0x90,
        64,
        100,
        ...varLen(480),
        0x80,
        64,
        0,
        ...eot(),
      ],
    ]);

    const doc = await smfToProjectDocument(bytes, 'held.mid');

    expect(doc.tracks).toHaveLength(2);
    expect(doc.tracks.map((track) => track.instrument)).toEqual([
      { kind: 'synth-preset', preset: 'acoustic-piano', gmProgram: 0 },
      { kind: 'synth-preset', preset: 'sub-bass', gmProgram: 38 },
    ]);
    expect(doc.tracks[0].clips[0].notes).toEqual([
      { pitch: 60, velocity: 100, startPpq: 0, durationPpq: 1, channel: 0 },
    ]);
    expect(doc.tracks[1].clips[0].notes).toEqual([
      { pitch: 64, velocity: 100, startPpq: 1, durationPpq: 1, channel: 0 },
    ]);
  });

  it('assigns GM program 0 to note-only MIDI tracks without program changes', async () => {
    const bytes = smf(0, 480, [
      [...varLen(0), 0x90, 60, 100, ...varLen(480), 0x80, 60, 0, ...eot()],
    ]);

    const doc = await smfToProjectDocument(bytes, 'plain.mid');

    expect(doc.tracks).toHaveLength(1);
    expect(doc.tracks[0].instrument).toEqual({
      kind: 'synth-preset',
      preset: 'acoustic-piano',
      gmProgram: 0,
    });
    expect(doc.tracks[0].clips[0].notes).toEqual([
      { pitch: 60, velocity: 100, startPpq: 0, durationPpq: 1, channel: 0 },
    ]);
  });

  it('rejects SMPTE time division', async () => {
    const bytes = smf(0, 0xe250, [[...eot()]]);
    await expect(smfToProjectDocument(bytes)).rejects.toThrow(/SMF|MIDI|import|SMPTE/i);
  });

  it('rejects empty MIDI input', async () => {
    await expect(smfToProjectDocument(new Uint8Array())).rejects.toThrow(/SMF|MIDI|import|header/i);
  });

  it('exports track instruments as program changes', async () => {
    const source: ProjectDocument = {
      schemaVersion: 3,
      name: 'Exported',
      sampleRate: 48000,
      tempoSegments: [{ startPpq: 0, bpm: 100 }],
      timeSignatures: [{ startPpq: 0, numerator: 4, denominator: 4 }],
      tracks: [
        {
          name: 'Bass',
          color: '#000',
          kind: 'midi',
          mute: false,
          solo: false,
          volume: 1,
          pan: 0,
          instrument: { kind: 'synth-preset', preset: 'sub-bass' },
          clips: [
            {
              name: 'Bass',
              startPpq: 0,
              lengthPpq: 1,
              sourceOffsetPpq: 0,
              gain: 1,
              loopEnabled: false,
              loopLengthPpq: 0,
              kind: 'midi',
              pitchBendLanes: [{ channel: 0, points: [{ ppq: 0.5, value: 4096 }] }],
              channelPressureLanes: [{ channel: 0, points: [{ ppq: 0.25, value: 50 }] }],
              polyPressureLanes: [{ channel: 0, pitch: 36, points: [{ ppq: 0.75, value: 90 }] }],
              notes: [{ pitch: 36, velocity: 100, startPpq: 0, durationPpq: 1, channel: 0 }],
            },
          ],
        },
      ],
      markers: [],
      sections: [{ name: 'Verse', color: '#60a5fa', startPpq: 0, endPpq: 1 }],
    };

    const roundTrip = await smfToProjectDocument(await projectDocumentToSmf(source), 'export.mid');

    expect(roundTrip.tempoSegments).toEqual([{ startPpq: 0, bpm: 100 }]);
    expect(roundTrip.markers).toEqual([{ ppq: 0, name: 'Cue: Verse' }]);
    expect(roundTrip.tracks[0].instrument).toEqual({
      kind: 'synth-preset',
      preset: 'sub-bass',
      gmProgram: 38,
    });
    expect(roundTrip.tracks[0].clips[0].notes).toEqual(source.tracks[0].clips[0].notes);
    expect(roundTrip.tracks[0].clips[0].pitchBendLanes).toEqual([
      { channel: 0, points: [{ ppq: 0.5, value: 4096 }] },
    ]);
    expect(roundTrip.tracks[0].clips[0].channelPressureLanes).toEqual([
      { channel: 0, points: [{ ppq: 0.25, value: 50 }] },
    ]);
    expect(roundTrip.tracks[0].clips[0].polyPressureLanes).toEqual([
      { channel: 0, pitch: 36, points: [{ ppq: 0.75, value: 90 }] },
    ]);
  });

  it('does not add a channel-0 program change to a channel-1-only track', async () => {
    const source: ProjectDocument = {
      schemaVersion: 3,
      name: 'Channel one',
      sampleRate: 48000,
      tempoSegments: [{ startPpq: 0, bpm: 120 }],
      timeSignatures: [{ startPpq: 0, numerator: 4, denominator: 4 }],
      tracks: [
        {
          name: 'Lead',
          color: '#000',
          kind: 'midi',
          mute: false,
          solo: false,
          volume: 1,
          pan: 0,
          instrument: { kind: 'synth-preset', preset: 'e-piano' },
          clips: [
            {
              name: 'Lead',
              startPpq: 0,
              lengthPpq: 1,
              sourceOffsetPpq: 0,
              gain: 1,
              loopEnabled: false,
              loopLengthPpq: 0,
              kind: 'midi',
              notes: [{ pitch: 60, velocity: 100, startPpq: 0, durationPpq: 1, channel: 1 }],
            },
          ],
        },
      ],
      markers: [],
      sections: [],
    };

    const roundTrip = await smfToProjectDocument(await projectDocumentToSmf(source), 'lead.mid');

    expect(roundTrip.tracks).toHaveLength(1);
    expect(roundTrip.tracks[0].clips[0].notes).toEqual(source.tracks[0].clips[0].notes);
  });

  it('materializes MIDI clip loops, expression and the final partial repeat in SMF', async () => {
    const source: ProjectDocument = {
      schemaVersion: 3,
      name: 'Loop export',
      sampleRate: 48000,
      tempoSegments: [{ startPpq: 0, bpm: 120 }],
      timeSignatures: [{ startPpq: 0, numerator: 4, denominator: 4 }],
      tracks: [
        {
          name: 'Loop',
          color: '#000',
          kind: 'midi',
          mute: false,
          solo: false,
          volume: 1,
          pan: 0,
          clips: [
            {
              name: 'Five beats',
              startPpq: 0,
              lengthPpq: 5,
              sourceOffsetPpq: 0,
              gain: 1,
              loopEnabled: true,
              loopLengthPpq: 2,
              kind: 'midi',
              notes: [{ pitch: 60, velocity: 100, startPpq: 0, durationPpq: 1, channel: 0 }],
              ccLanes: [{ controller: 1, channel: 0, points: [{ ppq: 0.5, value: 64 }] }],
            },
          ],
        },
      ],
      markers: [],
      sections: [],
    };

    const roundTrip = await smfToProjectDocument(await projectDocumentToSmf(source), 'loop.mid');

    expect(roundTrip.tracks[0].clips[0].notes).toEqual([
      { pitch: 60, velocity: 100, startPpq: 0, durationPpq: 1, channel: 0 },
      { pitch: 60, velocity: 100, startPpq: 2, durationPpq: 1, channel: 0 },
      { pitch: 60, velocity: 100, startPpq: 4, durationPpq: 1, channel: 0 },
    ]);
    expect(roundTrip.tracks[0].clips[0].ccLanes).toEqual([
      {
        controller: 1,
        channel: 0,
        points: [
          { ppq: 0.5, value: 64 },
          { ppq: 2.5, value: 64 },
          { ppq: 4.5, value: 64 },
        ],
      },
    ]);
  });

  it('round-trips clip program-change lanes through SMF events', async () => {
    const source: ProjectDocument = {
      schemaVersion: 3,
      name: 'Program lanes',
      sampleRate: 48000,
      tempoSegments: [{ startPpq: 0, bpm: 120 }],
      timeSignatures: [{ startPpq: 0, numerator: 4, denominator: 4 }],
      tracks: [
        {
          name: 'Patch lane',
          color: '#000',
          kind: 'midi',
          mute: false,
          solo: false,
          volume: 1,
          pan: 0,
          clips: [
            {
              name: 'Programs',
              startPpq: 0,
              lengthPpq: 2,
              sourceOffsetPpq: 0,
              gain: 1,
              loopEnabled: false,
              loopLengthPpq: 0,
              kind: 'midi',
              programChangeLanes: [
                {
                  channel: 2,
                  points: [{ ppq: 1, program: 24 }],
                },
              ],
              notes: [],
            },
          ],
        },
      ],
      markers: [],
      sections: [],
    };

    const roundTrip = await smfToProjectDocument(await projectDocumentToSmf(source), 'program.mid');

    expect(roundTrip.tracks[0].clips[0].programChangeLanes).toEqual(
      source.tracks[0].clips[0].programChangeLanes,
    );
  });

  it('round-trips app synth presets through GM program changes', async () => {
    const presets = [
      'acoustic-piano',
      'e-piano',
      'organ',
      'electric-guitar',
      'sub-bass',
      'warm-pad',
      'brass',
      'saw-lead',
      'square-lead',
      'pluck',
      'drum-kit',
      'sine',
    ];
    const source: ProjectDocument = {
      schemaVersion: 3,
      name: 'Presets',
      sampleRate: 48000,
      tempoSegments: [{ startPpq: 0, bpm: 120 }],
      timeSignatures: [{ startPpq: 0, numerator: 4, denominator: 4 }],
      tracks: presets.map((preset, index) => ({
        name: preset,
        color: '#000',
        kind: 'midi',
        mute: false,
        solo: false,
        volume: 1,
        pan: 0,
        instrument: { kind: 'synth-preset', preset },
        clips: [
          {
            name: preset,
            startPpq: index,
            lengthPpq: 1,
            sourceOffsetPpq: 0,
            gain: 1,
            loopEnabled: false,
            loopLengthPpq: 0,
            kind: 'midi',
            notes: [
              {
                pitch: 60,
                velocity: 100,
                startPpq: 0,
                durationPpq: 1,
                channel: 0,
              },
            ],
          },
        ],
      })),
      markers: [],
      sections: [],
    };

    const roundTrip = await smfToProjectDocument(await projectDocumentToSmf(source), 'presets.mid');

    expect(roundTrip.tracks.map((track) => track.instrument?.preset)).toEqual(presets);
  });

  it('preserves imported GM bank/program metadata when exporting SMF again', async () => {
    const source: ProjectDocument = {
      schemaVersion: 3,
      name: 'GM',
      sampleRate: 48000,
      tempoSegments: [{ startPpq: 0, bpm: 120 }],
      timeSignatures: [{ startPpq: 0, numerator: 4, denominator: 4 }],
      tracks: [
        {
          name: 'Cello-ish',
          color: '#000',
          kind: 'midi',
          mute: false,
          solo: false,
          volume: 1,
          pan: 0,
          instrument: { kind: 'synth-preset', preset: 'warm-pad', gmBank: 129, gmProgram: 42 },
          clips: [
            {
              name: 'Phrase',
              startPpq: 0,
              lengthPpq: 1,
              sourceOffsetPpq: 0,
              gain: 1,
              loopEnabled: false,
              loopLengthPpq: 0,
              kind: 'midi',
              notes: [{ pitch: 60, velocity: 100, startPpq: 0, durationPpq: 1, channel: 0 }],
            },
          ],
        },
      ],
      markers: [],
      sections: [],
    };

    const roundTrip = await smfToProjectDocument(await projectDocumentToSmf(source), 'gm.mid');

    expect(roundTrip.tracks[0].instrument).toEqual({
      kind: 'synth-preset',
      preset: 'warm-pad',
      gmBank: 129,
      gmProgram: 42,
    });
  });

  it('exports timeline markers as MIDI meta events', async () => {
    const source: ProjectDocument = {
      schemaVersion: 3,
      name: 'Markers',
      sampleRate: 48000,
      tempoSegments: [{ startPpq: 0, bpm: 120 }],
      timeSignatures: [{ startPpq: 0, numerator: 4, denominator: 4 }],
      tracks: [
        {
          name: 'Piano',
          color: '#000',
          kind: 'midi',
          mute: false,
          solo: false,
          volume: 1,
          pan: 0,
          clips: [
            {
              name: 'Piano',
              startPpq: 0,
              lengthPpq: 1,
              sourceOffsetPpq: 0,
              gain: 1,
              loopEnabled: false,
              loopLengthPpq: 0,
              kind: 'midi',
              notes: [{ pitch: 60, velocity: 100, startPpq: 0, durationPpq: 1, channel: 0 }],
            },
          ],
        },
      ],
      markers: [
        { ppq: 0, name: 'Intro' },
        { ppq: 0.25, name: 'Lyric: hi' },
        { ppq: 0.5, name: 'Cue: hit' },
        { ppq: 0.75, name: 'Text: note' },
        { ppq: 1, name: 'Key: E minor' },
      ],
      sections: [],
    };

    const roundTrip = await smfToProjectDocument(await projectDocumentToSmf(source), 'markers.mid');

    expect(roundTrip.markers).toEqual(source.markers);
  });

  it('clamps invalid exported MIDI byte values and falls back from invalid tempo', async () => {
    const source: ProjectDocument = {
      schemaVersion: 3,
      name: 'Clamped',
      sampleRate: 48000,
      tempoSegments: [{ startPpq: 0, bpm: Number.NaN }],
      timeSignatures: [{ startPpq: 0, numerator: 999, denominator: 3 }],
      tracks: [
        {
          name: 'Unsafe',
          color: '#000',
          kind: 'midi',
          mute: false,
          solo: false,
          volume: 1,
          pan: 0,
          clips: [
            {
              name: 'Unsafe',
              startPpq: 0,
              lengthPpq: 1,
              sourceOffsetPpq: 0,
              gain: 1,
              loopEnabled: false,
              loopLengthPpq: 0,
              kind: 'midi',
              ccLanes: [{ controller: 200, channel: 0, points: [{ ppq: 0, value: 200 }] }],
              channelPressureLanes: [{ channel: 0, points: [{ ppq: 0, value: 200 }] }],
              polyPressureLanes: [{ channel: 0, pitch: 200, points: [{ ppq: 0, value: 200 }] }],
              notes: [
                {
                  pitch: 200,
                  velocity: 200,
                  startPpq: 0,
                  durationPpq: 1,
                  channel: 0,
                  offVelocity: 200,
                },
              ],
            },
          ],
        },
      ],
      markers: [],
      sections: [],
    };

    const roundTrip = await smfToProjectDocument(await projectDocumentToSmf(source), 'clamped.mid');

    expect(roundTrip.tempoSegments).toEqual([{ startPpq: 0, bpm: 120 }]);
    expect(roundTrip.timeSignatures).toEqual([{ startPpq: 0, numerator: 255, denominator: 4 }]);
    expect(roundTrip.tracks[0].clips[0].ccLanes).toEqual([
      { controller: 127, channel: 0, points: [{ ppq: 0, value: 127 }] },
    ]);
    expect(roundTrip.tracks[0].clips[0].channelPressureLanes).toEqual([
      { channel: 0, points: [{ ppq: 0, value: 127 }] },
    ]);
    expect(roundTrip.tracks[0].clips[0].polyPressureLanes).toEqual([
      { channel: 0, pitch: 127, points: [{ ppq: 0, value: 127 }] },
    ]);
    expect(roundTrip.tracks[0].clips[0].notes).toEqual([
      {
        pitch: 127,
        velocity: 127,
        startPpq: 0,
        durationPpq: 1,
        channel: 0,
        offVelocity: 127,
      },
    ]);
  });
});

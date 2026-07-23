import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it, vi } from 'vitest';
import {
  DAWPROJECT_FILE_EXTENSION,
  type DawprojectExportOptions,
  DawprojectSizeError,
  dawprojectFilename,
  exportDawproject,
  exportDawprojectWithReport,
  importDawproject,
} from '@/export/dawproject';
import { dbToLinear, type InsertSlot } from '@/project/mixer';
import type { DocumentClip, DocumentTrack, ProjectDocument } from '@/project/serialization';
import { normalizeTempoMap, ppqRangeSamples } from '@/project/tempo-map';

const SAMPLE_RATE = 48000;

function makeDoc(
  tracks: DocumentTrack[],
  overrides: Partial<ProjectDocument> = {},
): ProjectDocument {
  return {
    schemaVersion: 3,
    name: 'DAWproject test',
    sampleRate: SAMPLE_RATE,
    tempoSegments: [{ startPpq: 0, bpm: 120 }],
    timeSignatures: [{ startPpq: 0, numerator: 4, denominator: 4 }],
    tracks,
    markers: [],
    sections: [],
    ...overrides,
  };
}

function makeTrack(clips: DocumentClip[], overrides: Partial<DocumentTrack> = {}): DocumentTrack {
  return {
    name: 'Track',
    color: '#60a5fa',
    kind: 'midi',
    mute: false,
    solo: false,
    volume: 1,
    pan: 0,
    clips,
    ...overrides,
  };
}

function makeMidiClip(overrides: Partial<DocumentClip> = {}): DocumentClip {
  return {
    name: 'MIDI clip',
    startPpq: 4,
    lengthPpq: 8,
    sourceOffsetPpq: 2,
    gain: 1,
    loopEnabled: false,
    loopLengthPpq: 0,
    notes: [
      { pitch: 60, velocity: 127, startPpq: 2, durationPpq: 1, channel: 0 },
      { pitch: 64, velocity: 64, startPpq: 3.5, durationPpq: 0.25, channel: 1, offVelocity: 32 },
    ],
    kind: 'midi',
    ...overrides,
  };
}

function makeAudioClip(overrides: Partial<DocumentClip> = {}): DocumentClip {
  return {
    name: 'Audio clip',
    startPpq: 0,
    lengthPpq: 4,
    sourceOffsetPpq: 1,
    gain: 1,
    loopEnabled: false,
    loopLengthPpq: 0,
    notes: [],
    kind: 'audio',
    assetId: 'asset-1',
    fadeInPpq: 0.5,
    fadeOutPpq: 1,
    ...overrides,
  };
}

/** Stub asset loader: mono, 11025 frames at 22050 Hz = 0.5 s. */
function makeAssetLoader(frames = 11025, sampleRate = 22050) {
  return vi.fn(async (assetId: string) => ({
    meta: { id: assetId, name: assetId, sampleRate, numChannels: 1, numFrames: frames },
    channels: [new Float32Array(frames).fill(0.25)],
  }));
}

async function exportAndUnzip(
  doc: ProjectDocument,
  options: DawprojectExportOptions,
): Promise<Record<string, Uint8Array>> {
  return unzipSync(await exportDawproject(doc, options));
}

function parseEntry(entries: Record<string, Uint8Array>, name: string): Document {
  const bytes = entries[name];
  expect(bytes).toBeDefined();
  const parsed = new DOMParser().parseFromString(strFromU8(bytes), 'application/xml');
  expect(parsed.querySelector('parsererror')).toBeNull();
  return parsed;
}

function parseSonareMetadata(entries: Record<string, Uint8Array>) {
  const bytes = entries['sonare-studio.json'];
  expect(bytes).toBeDefined();
  return JSON.parse(new TextDecoder().decode(bytes)) as {
    sidechainSources?: Record<string, number>;
    tracks?: Record<
      string,
      { kind?: string; stripGainDb?: number; vcaId?: string; volume?: number }
    >;
    vcaGroups?: Array<{ gainDb: number; id: string; name: string }>;
  };
}

async function exportProjectXml(
  doc: ProjectDocument,
  options: DawprojectExportOptions = { includeAudio: false },
): Promise<Document> {
  return parseEntry(await exportAndUnzip(doc, options), 'project.xml');
}

function attr(element: Element | null | undefined, name: string): string | null {
  expect(element).toBeTruthy();
  return (element as Element).getAttribute(name);
}

function floatAttr(element: Element | null | undefined, name: string): number {
  const value = attr(element, name);
  expect(value).not.toBeNull();
  return Number.parseFloat(value as string);
}

describe('exportDawproject structure', () => {
  it('writes standard XML plus a separate Sonare extension entry into the archive', async () => {
    const entries = await exportAndUnzip(makeDoc([]), { includeAudio: false });
    expect(Object.keys(entries).sort()).toEqual([
      'metadata.xml',
      'project.xml',
      'sonare-studio.json',
    ]);
  });

  it('rejects the reserved renderMidiTracks option instead of ignoring it', async () => {
    await expect(
      exportDawproject(makeDoc([makeTrack([makeMidiClip()])]), {
        includeAudio: false,
        renderMidiTracks: true,
      } as unknown as DawprojectExportOptions),
    ).rejects.toThrow(/rendering MIDI tracks to audio/);
  });

  it('writes the root Project, Application and metadata title', async () => {
    const doc = makeDoc([], { name: 'Tom & "Jerry" <Live>' });
    const entries = await exportAndUnzip(doc, { includeAudio: false });
    const project = parseEntry(entries, 'project.xml');
    expect(project.documentElement.tagName).toBe('Project');
    expect(attr(project.documentElement, 'version')).toBe('1.0');
    const application = project.querySelector('Project > Application');
    expect(attr(application, 'name')).toBe('sonare-studio');
    expect(attr(application, 'version')).not.toBeNull();
    const metadata = parseEntry(entries, 'metadata.xml');
    expect(metadata.documentElement.tagName).toBe('MetaData');
    expect(metadata.querySelector('Title')?.textContent).toBe('Tom & "Jerry" <Live>');
  });

  it('writes the transport tempo and time signature', async () => {
    const project = await exportProjectXml(
      makeDoc([], {
        tempoSegments: [{ startPpq: 0, bpm: 97.5 }],
        timeSignatures: [{ startPpq: 0, numerator: 7, denominator: 8 }],
      }),
    );
    const tempo = project.querySelector('Transport > Tempo');
    expect(attr(tempo, 'unit')).toBe('bpm');
    expect(floatAttr(tempo, 'value')).toBe(97.5);
    const signature = project.querySelector('Transport > TimeSignature');
    expect(attr(signature, 'numerator')).toBe('7');
    expect(attr(signature, 'denominator')).toBe('8');
  });

  it('maps tracks to Structure with content types, channels and a master track', async () => {
    const doc = makeDoc(
      [
        makeTrack([], {
          name: 'Lead "A" & <B>',
          kind: 'midi',
          volume: 0.5,
          mute: true,
          mixer: { gainDb: 6, pan: 0.5, inserts: [], sends: [] },
        }),
        makeTrack([], { name: 'Drums', kind: 'audio', solo: true, color: 'not-a-hex-color' }),
      ],
      { mixer: { master: { gainDb: -6, pan: -1, inserts: [], sends: [] }, buses: [] } },
    );
    const entries = await exportAndUnzip(doc, { includeAudio: false });
    const project = parseEntry(entries, 'project.xml');
    const tracks = [...project.querySelectorAll('Structure > Track')];
    expect(tracks).toHaveLength(3);

    expect(attr(tracks[0], 'contentType')).toBe('notes');
    expect(attr(tracks[0], 'name')).toBe('Lead "A" & <B>');
    expect(attr(tracks[0], 'color')).toBe('#60a5fa');
    const channel0 = tracks[0].querySelector('Channel');
    expect(attr(channel0, 'role')).toBe('regular');
    expect(attr(channel0, 'solo')).toBe('false');
    const volume0 = channel0?.querySelector('Volume');
    expect(attr(volume0, 'unit')).toBe('linear');
    expect(floatAttr(volume0, 'value')).toBeCloseTo(0.5 * dbToLinear(6), 5);
    const pan0 = channel0?.querySelector('Pan');
    expect(attr(pan0, 'unit')).toBe('normalized');
    expect(floatAttr(pan0, 'value')).toBeCloseTo(0.75, 6);
    expect(attr(channel0?.querySelector('Mute'), 'value')).toBe('true');

    expect(attr(tracks[1], 'contentType')).toBe('audio');
    expect(attr(tracks[1], 'color')).toBeNull();
    expect(attr(tracks[1].querySelector('Channel'), 'solo')).toBe('true');

    const masterTrack = tracks[2];
    expect(attr(masterTrack, 'contentType')).toBe('tracks');
    const masterChannel = masterTrack.querySelector('Channel');
    expect(attr(masterChannel, 'role')).toBe('master');
    expect(floatAttr(masterChannel?.querySelector('Volume'), 'value')).toBeCloseTo(
      dbToLinear(-6),
      6,
    );
    expect(floatAttr(masterChannel?.querySelector('Pan'), 'value')).toBe(0);
    // Regular channels route to the master channel.
    expect(attr(channel0, 'destination')).toBe(attr(masterChannel, 'id'));
  });

  it('preserves loud gains above +6 dB by widening the volume parameter range', async () => {
    const doc = makeDoc([
      makeTrack([], { volume: 1, mixer: { gainDb: 24, pan: 0, inserts: [], sends: [] } }),
    ]);
    const entries = await exportAndUnzip(doc, { includeAudio: false });
    const project = parseEntry(entries, 'project.xml');
    const volume = project.querySelector('Structure > Track Volume');
    // +24 dB ≈ 15.85 linear must not be clamped to the conventional [0, 2] cap.
    expect(floatAttr(volume, 'value')).toBeCloseTo(dbToLinear(24), 5);
    expect(floatAttr(volume, 'max')).toBeCloseTo(dbToLinear(24), 5);
  });

  it('keeps the conventional volume max for in-range gains', async () => {
    const doc = makeDoc([
      makeTrack([], { volume: 1, mixer: { gainDb: 0, pan: 0, inserts: [], sends: [] } }),
    ]);
    const entries = await exportAndUnzip(doc, { includeAudio: false });
    const project = parseEntry(entries, 'project.xml');
    const volume = project.querySelector('Structure > Track Volume');
    expect(floatAttr(volume, 'value')).toBe(1);
    expect(floatAttr(volume, 'max')).toBe(2);
  });

  it('folds a VCA group offset into each member track channel volume', async () => {
    const doc = makeDoc(
      [
        makeTrack([], { name: 'A', volume: 1, vcaId: 'vca-1' }),
        makeTrack([], { name: 'B', volume: 0.5 }),
      ],
      {
        mixer: {
          master: { gainDb: 0, pan: 0, inserts: [], sends: [] },
          buses: [],
          vcaGroups: [{ id: 'vca-1', name: 'Group', gainDb: -6 }],
        },
      },
    );
    const entries = await exportAndUnzip(doc, { includeAudio: false });
    const project = parseEntry(entries, 'project.xml');
    const sonareMetadata = parseSonareMetadata(entries);
    const tracks = project.querySelectorAll('Structure > Track');
    const memberVolume = tracks[0].querySelector('Channel > Volume');
    const nonMemberVolume = tracks[1].querySelector('Channel > Volume');
    expect(floatAttr(memberVolume, 'value')).toBeCloseTo(dbToLinear(-6), 5);
    expect(floatAttr(nonMemberVolume, 'value')).toBeCloseTo(0.5, 5);
    expect(sonareMetadata.tracks?.['track-0']).toMatchObject({ vcaId: 'vca-1', volume: 1 });
    expect(sonareMetadata.vcaGroups).toContainEqual({ id: 'vca-1', name: 'Group', gainDb: -6 });
  });

  it('maps aux tracks to effect channels', async () => {
    const entries = await exportAndUnzip(makeDoc([makeTrack([], { kind: 'aux' })]), {
      includeAudio: false,
    });
    const project = parseEntry(entries, 'project.xml');
    const sonareMetadata = parseSonareMetadata(entries);
    const channel = project.querySelector('Structure > Track > Channel');
    expect(attr(channel, 'role')).toBe('effect');
    expect(attr(project.querySelector('Structure > Track'), 'contentType')).toBe('audio');
    expect(sonareMetadata.tracks?.['track-0']?.kind).toBe('aux');
  });

  it('exports mixer buses as effect channels with output and send routing', async () => {
    const entries = await exportAndUnzip(
      makeDoc(
        [
          makeTrack([], {
            name: 'Dry',
            kind: 'audio',
            mixer: {
              gainDb: 0,
              pan: 0,
              inserts: [],
              sends: [{ busId: 'bus-1', levelDb: -12, enabled: true, timing: 'preFader' }],
              outputBusId: 'bus-1',
            },
          }),
        ],
        {
          mixer: {
            master: { gainDb: 0, pan: 0, inserts: [], sends: [] },
            buses: [
              {
                id: 'bus-1',
                name: 'FX Return',
                gainDb: -6,
                strip: { gainDb: 0, pan: 0.25, inserts: [], sends: [] },
              },
            ],
          },
        },
      ),
      { includeAudio: false },
    );
    const project = parseEntry(entries, 'project.xml');
    const tracks = [...project.querySelectorAll('Structure > Track')];
    expect(tracks).toHaveLength(3);
    const dryChannel = tracks[0].querySelector('Channel');
    const busChannel = tracks[1].querySelector('Channel');

    expect(attr(tracks[1], 'name')).toBe('FX Return');
    expect(attr(busChannel, 'role')).toBe('effect');
    expect(floatAttr(busChannel?.querySelector('Volume'), 'value')).toBeCloseTo(dbToLinear(-6), 5);
    expect(floatAttr(busChannel?.querySelector('Pan'), 'value')).toBeCloseTo(0.625, 6);
    expect(attr(dryChannel, 'destination')).toBe(attr(busChannel, 'id'));

    const send = dryChannel?.querySelector('Sends > Send');
    expect(attr(send, 'destination')).toBe(attr(busChannel, 'id'));
    expect(attr(send, 'type')).toBe('pre');
    expect(attr(send?.querySelector('Mute'), 'value')).toBe('false');
    expect(floatAttr(send?.querySelector('Volume'), 'value')).toBeCloseTo(dbToLinear(-12), 5);
  });

  it('exports sonare insert slots as generic BuiltinDevice entries', async () => {
    const entries = await exportAndUnzip(
      makeDoc([
        makeTrack([], {
          mixer: {
            gainDb: 0,
            pan: 0,
            inserts: [
              {
                processor: 'dynamics.compressor',
                params: { thresholdDb: -18, autoMakeup: true },
                enabled: false,
                sidechainSourceIndex: 1,
              } as InsertSlot & { sidechainSourceIndex: number },
            ],
            sends: [],
          },
        }),
        makeTrack([], { name: 'Key Source' }),
      ]),
      { includeAudio: false },
    );
    const project = parseEntry(entries, 'project.xml');
    const sonareMetadata = parseSonareMetadata(entries);
    const device = project.querySelector('Structure > Track > Channel > Devices > BuiltinDevice');

    expect(attr(device, 'deviceVendor')).toBe('sonare-studio');
    expect(attr(device, 'deviceName')).toBe('dynamics.compressor');
    expect(attr(device, 'deviceRole')).toBe('audioFX');
    expect(attr(device?.querySelector('Enabled'), 'value')).toBe('false');
    expect(floatAttr(device?.querySelector('RealParameter[name="thresholdDb"]'), 'value')).toBe(
      -18,
    );
    expect(attr(device?.querySelector('BoolParameter[name="autoMakeup"]'), 'value')).toBe('true');
    expect(sonareMetadata.sidechainSources?.['channel-0-insert-0']).toBe(1);
  });

  it('exports bus and master insert sidechain source indexes as sonare metadata', async () => {
    const entries = await exportAndUnzip(
      makeDoc([makeTrack([], { name: 'Key Source' })], {
        mixer: {
          master: {
            gainDb: 0,
            pan: 0,
            inserts: [
              {
                processor: 'dynamics.compressor',
                params: { thresholdDb: -10 },
                enabled: true,
                sidechainSourceIndex: 0,
              } as InsertSlot & { sidechainSourceIndex: number },
            ],
            sends: [],
          },
          buses: [
            {
              id: 'bus-1',
              name: 'Return',
              gainDb: 0,
              strip: {
                gainDb: 0,
                pan: 0,
                inserts: [
                  {
                    processor: 'saturation.tape',
                    params: { drive: 0.5 },
                    enabled: true,
                    sidechainSourceIndex: 0,
                  } as InsertSlot & { sidechainSourceIndex: number },
                ],
                sends: [],
              },
            },
          ],
        },
      }),
      { includeAudio: false },
    );
    const project = parseEntry(entries, 'project.xml');
    const sonareMetadata = parseSonareMetadata(entries);

    const busDevice = project.querySelector('Channel[role="effect"] BuiltinDevice');
    const masterDevice = project.querySelector('Channel[role="master"] BuiltinDevice');

    expect(attr(busDevice, 'id')).toBe('bus-channel-0-insert-0');
    expect(attr(masterDevice, 'id')).toBe('master-channel-insert-0');
    expect(sonareMetadata.sidechainSources).toMatchObject({
      'bus-channel-0-insert-0': 0,
      'master-channel-insert-0': 0,
    });
  });

  it('exports grouped tracks as nested Structure tracks', async () => {
    const entries = await exportAndUnzip(
      makeDoc([
        makeTrack([], { name: 'Drum Bus', kind: 'group' }),
        makeTrack([], { name: 'Kick', kind: 'audio', groupIndex: 0 }),
      ]),
      { includeAudio: false },
    );
    const project = parseEntry(entries, 'project.xml');
    const topLevelTracks = [...(project.querySelector('Structure')?.children ?? [])].filter(
      (element) => element.tagName === 'Track',
    );
    const group = topLevelTracks[0];
    const nestedTracks = [...group.children].filter((element) => element.tagName === 'Track');

    expect(topLevelTracks).toHaveLength(2);
    expect(attr(group, 'name')).toBe('Drum Bus');
    expect(attr(group, 'contentType')).toBe('tracks');
    expect(nestedTracks).toHaveLength(1);
    expect(attr(nestedTracks[0], 'name')).toBe('Kick');
    expect(attr(nestedTracks[0], 'id')).toBe('track-1');
  });

  it('does not export group track target insert sidechain metadata', async () => {
    const entries = await exportAndUnzip(
      makeDoc([
        makeTrack([], {
          name: 'Drum Bus',
          kind: 'group',
          mixer: {
            gainDb: 0,
            pan: 0,
            inserts: [
              {
                processor: 'dynamics.compressor',
                params: { thresholdDb: -18 },
                enabled: true,
                sidechainSourceIndex: 1,
              } as InsertSlot & { sidechainSourceIndex: number },
            ],
            sends: [],
          },
        }),
        makeTrack([], { name: 'Key Source', kind: 'audio' }),
      ]),
      { includeAudio: false },
    );
    const project = parseEntry(entries, 'project.xml');
    const sonareMetadata = parseSonareMetadata(entries);
    const device = project.querySelector(
      'Structure > Track[contentType="tracks"] > Channel > Devices > BuiltinDevice',
    );

    expect(attr(device, 'deviceName')).toBe('dynamics.compressor');
    expect(sonareMetadata.sidechainSources?.['channel-0-insert-0']).toBeUndefined();
  });
});

describe('exportDawproject arrangement', () => {
  it('maps MIDI clips to note clips with beat times', async () => {
    const project = await exportProjectXml(makeDoc([makeTrack([makeMidiClip()])]));
    const lanes = project.querySelector('Arrangement > Lanes');
    expect(attr(lanes, 'timeUnit')).toBe('beats');
    const trackLanes = lanes?.querySelector('Lanes');
    expect(attr(trackLanes, 'track')).toBe('track-0');

    const clip = trackLanes?.querySelector('Clips > Clip');
    expect(floatAttr(clip, 'time')).toBe(4);
    expect(floatAttr(clip, 'duration')).toBe(8);
    expect(floatAttr(clip, 'playStart')).toBe(2);
    expect(attr(clip, 'contentTimeUnit')).toBe('beats');

    const notes = [...(clip?.querySelectorAll('Notes > Note') ?? [])];
    expect(notes).toHaveLength(2);
    expect(floatAttr(notes[0], 'time')).toBe(2);
    expect(floatAttr(notes[0], 'duration')).toBe(1);
    expect(attr(notes[0], 'key')).toBe('60');
    expect(attr(notes[0], 'channel')).toBe('0');
    expect(floatAttr(notes[0], 'vel')).toBe(1);
    // No source off-velocity: the optional 'rel' attribute is omitted rather
    // than defaulted to the on-velocity.
    expect(notes[0].hasAttribute('rel')).toBe(false);
    expect(floatAttr(notes[1], 'time')).toBe(3.5);
    expect(floatAttr(notes[1], 'duration')).toBe(0.25);
    expect(attr(notes[1], 'key')).toBe('64');
    expect(attr(notes[1], 'channel')).toBe('1');
    expect(floatAttr(notes[1], 'vel')).toBeCloseTo(64 / 127, 6);
    expect(floatAttr(notes[1], 'rel')).toBeCloseTo(32 / 127, 6);
  });

  it('exports loop windows on looping MIDI clips', async () => {
    const project = await exportProjectXml(
      makeDoc([makeTrack([makeMidiClip({ loopEnabled: true, loopLengthPpq: 2 })])]),
    );
    const clip = project.querySelector('Arrangement Clip');
    expect(floatAttr(clip, 'loopStart')).toBe(2);
    expect(floatAttr(clip, 'loopEnd')).toBe(4);
    const fullWindow = await exportProjectXml(
      makeDoc([makeTrack([makeMidiClip({ loopEnabled: true, loopLengthPpq: 0 })])]),
    );
    expect(floatAttr(fullWindow.querySelector('Arrangement Clip'), 'loopEnd')).toBe(10);
  });

  it('exports MIDI expression lanes as clip-local Points', async () => {
    const project = await exportProjectXml(
      makeDoc([
        makeTrack([
          makeMidiClip({
            ccLanes: [
              {
                channel: 1,
                controller: 11,
                points: [
                  { ppq: 0, value: 32 },
                  { ppq: 2, value: 96 },
                ],
              },
            ],
            pitchBendLanes: [{ channel: 2, points: [{ ppq: 1, value: 8192 }] }],
            programChangeLanes: [{ channel: 3, points: [{ ppq: 1.5, program: 24 }] }],
            channelPressureLanes: [{ channel: 4, points: [{ ppq: 2.5, value: 80 }] }],
            polyPressureLanes: [{ channel: 5, pitch: 64, points: [{ ppq: 3.5, value: 70 }] }],
          }),
        ]),
      ]),
    );

    const clip = project.querySelector('Arrangement Clip');
    const cc = clip?.querySelector('Points[id="midi-expression-0-0-cc-1-11"]');
    expect(attr(cc, 'unit')).toBe('midi-7bit');
    expect(attr(cc?.querySelector('Target'), 'parameter')).toBe('midi.cc.1.11');
    const ccPoints = [...(cc?.querySelectorAll('RealPoint') ?? [])];
    expect(ccPoints).toHaveLength(2);
    expect(floatAttr(ccPoints[0], 'time')).toBe(0);
    expect(floatAttr(ccPoints[0], 'value')).toBe(32);
    expect(attr(ccPoints[0], 'interpolation')).toBe('hold');
    expect(floatAttr(ccPoints[1], 'time')).toBe(2);
    expect(floatAttr(ccPoints[1], 'value')).toBe(96);

    const pitchBend = clip?.querySelector('Points[id="midi-expression-0-0-pitchBend-2"]');
    expect(attr(pitchBend, 'unit')).toBe('midi-14bit');
    expect(attr(pitchBend?.querySelector('Target'), 'parameter')).toBe('midi.pitchBend.2');
    expect(floatAttr(pitchBend?.querySelector('RealPoint'), 'value')).toBe(8192);

    const program = clip?.querySelector('Points[id="midi-expression-0-0-program-3"]');
    expect(attr(program, 'unit')).toBe('midi-program');
    expect(attr(program?.querySelector('Target'), 'parameter')).toBe('midi.program.3');
    expect(floatAttr(program?.querySelector('RealPoint'), 'value')).toBe(24);

    const channelPressure = clip?.querySelector(
      'Points[id="midi-expression-0-0-channelPressure-4"]',
    );
    expect(attr(channelPressure?.querySelector('Target'), 'parameter')).toBe(
      'midi.channelPressure.4',
    );
    expect(floatAttr(channelPressure?.querySelector('RealPoint'), 'value')).toBe(80);

    const polyPressure = clip?.querySelector('Points[id="midi-expression-0-0-polyPressure-5-64"]');
    expect(attr(polyPressure?.querySelector('Target'), 'parameter')).toBe('midi.polyPressure.5.64');
    expect(floatAttr(polyPressure?.querySelector('RealPoint'), 'value')).toBe(70);
  });

  it('exports markers and sections as cue markers ordered by time', async () => {
    const project = await exportProjectXml(
      makeDoc([], {
        markers: [{ ppq: 16, name: 'Drop' }],
        sections: [{ name: 'Chorus', color: '#123456', startPpq: 8, endPpq: 16 }],
      }),
    );
    const markers = [...project.querySelectorAll('Arrangement > Markers > Marker')];
    expect(markers).toHaveLength(2);
    expect(floatAttr(markers[0], 'time')).toBe(8);
    expect(attr(markers[0], 'name')).toBe('Section: Chorus');
    expect(floatAttr(markers[1], 'time')).toBe(16);
    expect(attr(markers[1], 'name')).toBe('Drop');
  });

  it('omits the Markers element when there are no markers or sections', async () => {
    const project = await exportProjectXml(makeDoc([]));
    expect(project.querySelector('Markers')).toBeNull();
  });

  it('keeps a constant tempo as a single transport value without automation', async () => {
    const project = await exportProjectXml(makeDoc([]));
    expect(project.querySelector('TempoAutomation')).toBeNull();
    expect(project.querySelector('TimeSignatureAutomation')).toBeNull();
  });

  it('exports tempo changes and ramps as automation points', async () => {
    const project = await exportProjectXml(
      makeDoc([makeTrack([makeMidiClip({ startPpq: 8, lengthPpq: 16 })])], {
        tempoSegments: [
          { startPpq: 0, bpm: 120, endBpm: 140 },
          { startPpq: 8, bpm: 150 },
          { startPpq: 16, bpm: 90, endBpm: 100 },
        ],
      }),
    );
    expect(floatAttr(project.querySelector('Transport > Tempo'), 'value')).toBe(120);
    const automation = project.querySelector('Arrangement > TempoAutomation');
    expect(attr(automation, 'unit')).toBe('bpm');
    expect(attr(automation?.querySelector('Target'), 'parameter')).toBe(
      attr(project.querySelector('Transport > Tempo'), 'id'),
    );
    const points = [...(automation?.querySelectorAll('RealPoint') ?? [])];
    const triple = points.map((p) => [
      floatAttr(p, 'time'),
      floatAttr(p, 'value'),
      attr(p, 'interpolation'),
    ]);
    expect(triple).toEqual([
      [0, 120, 'linear'],
      [8, 140, 'hold'],
      [8, 150, 'hold'],
      [16, 90, 'linear'],
      // Open-ended final ramp ends at the arrangement content end (8 + 16).
      [24, 100, 'hold'],
    ]);
  });

  it('exports multiple time signatures as automation points', async () => {
    const project = await exportProjectXml(
      makeDoc([], {
        timeSignatures: [
          { startPpq: 0, numerator: 4, denominator: 4 },
          { startPpq: 12, numerator: 3, denominator: 8 },
        ],
      }),
    );
    const automation = project.querySelector('Arrangement > TimeSignatureAutomation');
    const points = [...(automation?.querySelectorAll('TimeSignaturePoint') ?? [])];
    expect(points).toHaveLength(2);
    expect(floatAttr(points[1], 'time')).toBe(12);
    expect(attr(points[1], 'numerator')).toBe('3');
    expect(attr(points[1], 'denominator')).toBe('8');
  });
});

describe('exportDawproject audio', () => {
  it('embeds referenced assets as 24-bit WAV entries when includeAudio is true', async () => {
    const doc = makeDoc([makeTrack([makeAudioClip()], { kind: 'audio' })]);
    const loader = makeAssetLoader();
    const entries = await exportAndUnzip(doc, { includeAudio: true, loadAudioAsset: loader });
    expect(loader).toHaveBeenCalledWith('asset-1');
    const wav = entries['audio/asset-1.wav'];
    expect(wav).toBeDefined();
    expect(strFromU8(wav.slice(0, 4))).toBe('RIFF');
    expect(strFromU8(wav.slice(8, 12))).toBe('WAVE');
    expect(new DataView(wav.buffer, wav.byteOffset, wav.byteLength).getUint16(34, true)).toBe(24);

    const project = parseEntry(entries, 'project.xml');
    const audio = project.querySelector('Arrangement Clip > Audio');
    expect(attr(audio, 'channels')).toBe('1');
    expect(attr(audio, 'sampleRate')).toBe('22050');
    expect(floatAttr(audio, 'duration')).toBeCloseTo(0.5, 6);
    expect(attr(audio?.querySelector('File'), 'path')).toBe('audio/asset-1.wav');
  });

  it('fails loudly when embedded audio exceeds the import budget', async () => {
    const doc = makeDoc([makeTrack([makeAudioClip()], { kind: 'audio' })]);
    const loader = makeAssetLoader();
    // The stub asset encodes to ~33 KB of 24-bit WAV; a tiny expanded budget
    // must reject it rather than build an archive this app could not re-import.
    await expect(
      exportDawproject(doc, {
        includeAudio: true,
        loadAudioAsset: loader,
        limits: { maxArchiveBytes: 1 << 30, maxExpandedBytes: 1024, maxEntryBytes: 1 << 30 },
      }),
    ).rejects.toBeInstanceOf(DawprojectSizeError);
  });

  it('embeds each asset once even when several clips reference it', async () => {
    const doc = makeDoc([
      makeTrack([makeAudioClip(), makeAudioClip({ startPpq: 8 })], { kind: 'audio' }),
    ]);
    const loader = makeAssetLoader();
    const entries = await exportAndUnzip(doc, { includeAudio: true, loadAudioAsset: loader });
    expect(loader).toHaveBeenCalledTimes(1);
    expect(Object.keys(entries).filter((name) => name.startsWith('audio/'))).toEqual([
      'audio/asset-1.wav',
    ]);
    const project = parseEntry(entries, 'project.xml');
    const files = [...project.querySelectorAll('Audio > File')];
    expect(files).toHaveLength(2);
    for (const file of files) expect(attr(file, 'path')).toBe('audio/asset-1.wav');
  });

  it('keeps the clip structure without payloads when includeAudio is false', async () => {
    const doc = makeDoc([makeTrack([makeAudioClip()], { kind: 'audio' })]);
    const loader = makeAssetLoader();
    const entries = await exportAndUnzip(doc, { includeAudio: false, loadAudioAsset: loader });
    expect(loader).not.toHaveBeenCalled();
    expect(Object.keys(entries).some((name) => name.startsWith('audio/'))).toBe(false);

    const project = parseEntry(entries, 'project.xml');
    const clip = project.querySelector('Arrangement Clip');
    expect(attr(clip, 'contentTimeUnit')).toBe('seconds');
    // sourceOffsetPpq 1 at 120 BPM = 0.5 s.
    expect(floatAttr(clip, 'playStart')).toBeCloseTo(0.5, 6);
    expect(attr(clip, 'fadeTimeUnit')).toBe('beats');
    expect(floatAttr(clip, 'fadeInTime')).toBe(0.5);
    expect(floatAttr(clip, 'fadeOutTime')).toBe(1);
    const audio = clip?.querySelector('Audio');
    // Media facts are estimated: stereo at the project rate, covering the
    // clip window (sourceOffsetPpq 1 + lengthPpq 4 = 2.5 s at 120 BPM).
    expect(attr(audio, 'channels')).toBe('2');
    expect(attr(audio, 'sampleRate')).toBe(String(SAMPLE_RATE));
    expect(attr(audio, 'timeUnit')).toBe('seconds');
    expect(floatAttr(audio, 'duration')).toBeCloseTo(2.5, 6);
    expect(attr(audio?.querySelector('File'), 'path')).toBe('audio/asset-1.wav');
  });

  it('emits strictly monotonic source times for a warp whose last anchor exceeds the linear tail', async () => {
    const project = await exportProjectXml(
      makeDoc([
        makeTrack(
          [
            makeAudioClip({
              warp: {
                enabled: true,
                sourceBpm: 120,
                anchors: [{ ppq: 3, sourceSeconds: 10 }],
              },
            }),
          ],
          { kind: 'audio' },
        ),
      ]),
    );
    const sourceTimes = [...project.querySelectorAll('Arrangement Warps > Warp')].map((point) =>
      floatAttr(point, 'contentTime'),
    );

    expect(sourceTimes).toHaveLength(3);
    expect(sourceTimes[2]).toBeGreaterThan(sourceTimes[1]);
  });

  it('uses the tempo map for audio content seconds', async () => {
    const doc = makeDoc([makeTrack([makeAudioClip()], { kind: 'audio' })], {
      tempoSegments: [
        { startPpq: 0, bpm: 120 },
        { startPpq: 2, bpm: 60 },
      ],
    });
    const project = await exportProjectXml(doc, { includeAudio: false });

    const clip = project.querySelector('Arrangement Clip');
    expect(attr(clip, 'contentTimeUnit')).toBe('seconds');
    // The source timeline starts at -1 PPQ. Both values are measured from
    // that origin, matching the source window used by live/offline playback.
    expect(floatAttr(clip, 'playStart')).toBeCloseTo(0.5, 6);
    expect(floatAttr(clip?.querySelector('Audio'), 'duration')).toBeCloseTo(3.5, 6);
  });

  it('anchors trimmed and looped content seconds at the source timeline origin', async () => {
    const tempoSegments = [
      { startPpq: 0, bpm: 120, endBpm: 72 },
      { startPpq: 8, bpm: 90 },
    ];
    const audioClip = makeAudioClip({
      startPpq: 6,
      lengthPpq: 4,
      sourceOffsetPpq: 3,
      loopEnabled: true,
      loopLengthPpq: 2,
    });
    const project = await exportProjectXml(
      makeDoc([makeTrack([audioClip], { kind: 'audio' })], { tempoSegments }),
      { includeAudio: false },
    );
    const clip = project.querySelector('Arrangement Clip');
    const tempoMap = normalizeTempoMap(tempoSegments);
    const originPpq = audioClip.startPpq - audioClip.sourceOffsetPpq;
    const playStartSeconds = floatAttr(clip, 'playStart');
    const loopEndSeconds = floatAttr(clip, 'loopEnd');
    const mediaDurationSeconds = floatAttr(clip?.querySelector('Audio'), 'duration');

    expect(playStartSeconds).toBeCloseTo(
      ppqRangeSamples(tempoMap, originPpq, audioClip.startPpq, SAMPLE_RATE) / SAMPLE_RATE,
      4,
    );
    expect(
      Math.abs(
        Math.round(playStartSeconds * SAMPLE_RATE) -
          ppqRangeSamples(tempoMap, originPpq, audioClip.startPpq, SAMPLE_RATE),
      ),
    ).toBeLessThanOrEqual(1);
    expect(
      Math.abs(
        Math.round(loopEndSeconds * SAMPLE_RATE) -
          ppqRangeSamples(tempoMap, originPpq, audioClip.startPpq + 2, SAMPLE_RATE),
      ),
    ).toBeLessThanOrEqual(1);
    expect(
      Math.abs(
        Math.round(mediaDurationSeconds * SAMPLE_RATE) -
          ppqRangeSamples(
            tempoMap,
            originPpq,
            audioClip.startPpq + audioClip.lengthPpq,
            SAMPLE_RATE,
          ),
      ),
    ).toBeLessThanOrEqual(1);
    expect(attr(clip, 'fadeTimeUnit')).toBe('beats');
    expect(floatAttr(clip, 'fadeInTime')).toBe(0.5);
    expect(floatAttr(clip, 'fadeOutTime')).toBe(1);
  });

  it('exports loop windows on looping audio clips in seconds', async () => {
    const project = await exportProjectXml(
      makeDoc([
        makeTrack([makeAudioClip({ loopEnabled: true, loopLengthPpq: 2 })], { kind: 'audio' }),
      ]),
    );
    const clip = project.querySelector('Arrangement Clip');
    // sourceOffsetPpq 1 at 120 BPM = 0.5 s; loop spans loopLengthPpq 2 = 1 s.
    expect(floatAttr(clip, 'loopStart')).toBeCloseTo(0.5, 6);
    expect(floatAttr(clip, 'loopEnd')).toBeCloseTo(1.5, 6);
  });

  it('loops over the clip length when an audio clip omits its loop length', async () => {
    const project = await exportProjectXml(
      makeDoc([
        makeTrack([makeAudioClip({ loopEnabled: true, loopLengthPpq: 0 })], { kind: 'audio' }),
      ]),
    );
    const clip = project.querySelector('Arrangement Clip');
    // Falls back to lengthPpq 4 = 2 s past the 0.5 s source offset.
    expect(floatAttr(clip, 'loopStart')).toBeCloseTo(0.5, 6);
    expect(floatAttr(clip, 'loopEnd')).toBeCloseTo(2.5, 6);
  });

  it('keeps the structural reference when an asset fails to load', async () => {
    const doc = makeDoc([makeTrack([makeAudioClip()], { kind: 'audio' })]);
    const loader = vi.fn(async () => {
      throw new Error('missing asset');
    });
    const entries = await exportAndUnzip(doc, { includeAudio: true, loadAudioAsset: loader });
    expect(Object.keys(entries).some((name) => name.startsWith('audio/'))).toBe(false);
    const project = parseEntry(entries, 'project.xml');
    expect(attr(project.querySelector('Audio > File'), 'path')).toBe('audio/asset-1.wav');
  });

  it('reports assets that could not be embedded as structured media failures', async () => {
    const doc = makeDoc([makeTrack([makeAudioClip()], { kind: 'audio' })]);
    const result = await exportDawprojectWithReport(doc, {
      includeAudio: true,
      loadAudioAsset: async () => {
        throw new Error('missing asset');
      },
    });

    expect(result.bytes.byteLength).toBeGreaterThan(0);
    expect(result.media).toEqual({ embeddedAssetIds: [], missingAssetIds: ['asset-1'] });
  });

  it('exports audio clips without an asset id as placement-only clips', async () => {
    const doc = makeDoc([makeTrack([makeAudioClip({ assetId: undefined })], { kind: 'audio' })]);
    const project = await exportProjectXml(doc, { includeAudio: true });
    const clip = project.querySelector('Arrangement Clip');
    expect(floatAttr(clip, 'time')).toBe(0);
    expect(clip?.querySelector('Audio')).toBeNull();
    expect(clip?.querySelector('Notes')).toBeNull();
  });

  it('exports track fader and pan automation as DAWproject Points lanes', async () => {
    const project = await exportProjectXml(
      makeDoc([
        makeTrack([], {
          automation: [
            {
              param: 'faderDb',
              enabled: true,
              points: [
                { ppq: 0, value: -6, curve: 'hold' },
                { ppq: 4, value: 0 },
              ],
            },
            {
              param: 'pan',
              enabled: true,
              points: [{ ppq: 2, value: 0.5 }],
            },
            {
              param: 'insert:0:gainDb',
              enabled: true,
              points: [{ ppq: 1, value: -12 }],
            },
            {
              param: 'faderDb',
              enabled: false,
              points: [{ ppq: 8, value: -24 }],
            },
          ],
        }),
      ]),
    );
    const points = [...project.querySelectorAll('Arrangement > Lanes > Lanes > Points')];

    expect(points).toHaveLength(2);
    const volume = points[0];
    expect(attr(volume, 'unit')).toBe('linear');
    expect(attr(volume.querySelector('Target'), 'parameter')).toBe('channel-0-volume');
    const volumePoints = [...volume.querySelectorAll('RealPoint')];
    expect(floatAttr(volumePoints[0], 'time')).toBe(0);
    expect(floatAttr(volumePoints[0], 'value')).toBeCloseTo(dbToLinear(-6), 5);
    expect(attr(volumePoints[0], 'interpolation')).toBe('hold');
    expect(floatAttr(volumePoints[1], 'time')).toBe(4);
    expect(floatAttr(volumePoints[1], 'value')).toBe(1);
    expect(attr(volumePoints[1], 'interpolation')).toBe('linear');

    const pan = points[1];
    expect(attr(pan, 'unit')).toBe('normalized');
    expect(attr(pan.querySelector('Target'), 'parameter')).toBe('channel-0-pan');
    expect(floatAttr(pan.querySelector('RealPoint'), 'value')).toBe(0.75);
  });

  it('round-trips instrument and mastering automation in sonare-scoped Points', async () => {
    const doc = makeDoc(
      [
        makeTrack([], {
          automation: [
            {
              param: 'instrument:cutoffHz',
              enabled: true,
              points: [
                { ppq: 0, value: 0.2, curve: 'hold' },
                { ppq: 4, value: 0.8 },
              ],
            },
          ],
        }),
      ],
      {
        masterAutomation: [
          {
            param: 'mastering:0:ceilingDb',
            enabled: true,
            points: [{ ppq: 2, value: -1 }],
          },
        ],
      },
    );
    const bytes = await exportDawproject(doc, { includeAudio: false });
    const project = parseEntry(unzipSync(bytes), 'project.xml');
    const targets = [...project.querySelectorAll('Arrangement Points Target')].map((target) =>
      target.getAttribute('parameter'),
    );
    expect(targets).toContain('sonare-automation:instrument%3AcutoffHz');
    expect(targets).toContain('sonare-automation:mastering%3A0%3AceilingDb');

    const imported = importDawproject(bytes);
    expect(imported.tracks[0].automation).toEqual([
      {
        param: 'instrument:cutoffHz',
        enabled: true,
        points: [
          { ppq: 0, value: 0.2, curve: 'hold' },
          { ppq: 4, value: 0.8, curve: 'linear' },
        ],
      },
    ]);
    expect(imported.masterAutomation).toEqual([
      {
        param: 'mastering:0:ceilingDb',
        enabled: true,
        points: [{ ppq: 2, value: -1, curve: 'linear' }],
      },
    ]);
  });

  it('exports track insert automation to the matching device parameter', async () => {
    const project = await exportProjectXml(
      makeDoc([
        makeTrack([], {
          mixer: {
            gainDb: 0,
            pan: 0,
            inserts: [
              {
                processor: 'dynamics.compressor',
                params: { thresholdDb: -18, autoMakeup: true },
                enabled: true,
              },
            ],
            sends: [],
          },
          automation: [
            {
              param: 'insert:0:thresholdDb',
              enabled: true,
              points: [
                { ppq: 0, value: -24, curve: 'hold' },
                { ppq: 4, value: -12 },
              ],
            },
            {
              param: 'insert:0:autoMakeup',
              enabled: true,
              points: [{ ppq: 2, value: 1 }],
            },
            {
              param: 'insert:1:thresholdDb',
              enabled: true,
              points: [{ ppq: 2, value: -6 }],
            },
          ],
        }),
      ]),
    );
    const points = [...project.querySelectorAll('Arrangement > Lanes > Lanes > Points')];

    expect(points).toHaveLength(2);
    expect(attr(points[0], 'id')).toBe('automation-0-insert_0_thresholdDb');
    expect(attr(points[0], 'unit')).toBe('normalized');
    expect(attr(points[0].querySelector('Target'), 'parameter')).toBe(
      'channel-0-insert-0-param-thresholdDb',
    );
    const realPoints = [...points[0].querySelectorAll('RealPoint')];
    expect(floatAttr(realPoints[0], 'value')).toBe(-24);
    expect(attr(realPoints[0], 'interpolation')).toBe('hold');
    expect(floatAttr(realPoints[1], 'value')).toBe(-12);

    expect(attr(points[1], 'id')).toBe('automation-0-insert_0_autoMakeup');
    expect(attr(points[1], 'unit')).toBe('bool');
    expect(attr(points[1].querySelector('Target'), 'parameter')).toBe(
      'channel-0-insert-0-param-autoMakeup',
    );
    const boolPoints = [...points[1].querySelectorAll('RealPoint')];
    expect(floatAttr(boolPoints[0], 'value')).toBe(1);
  });

  it('exports bus and master automation on synthetic arrangement lanes', async () => {
    const project = await exportProjectXml(
      makeDoc([], {
        mixer: {
          master: {
            gainDb: 0,
            pan: 0,
            inserts: [
              { processor: 'eq.tilt', params: { tiltDb: 1.5, oversample: true }, enabled: true },
            ],
            sends: [],
          },
          buses: [
            {
              id: 'bus-1',
              name: 'Return',
              gainDb: -3,
              strip: {
                gainDb: 0,
                pan: 0,
                inserts: [
                  {
                    processor: 'saturation.tape',
                    params: { drive: 0.7, bypassTone: false },
                    enabled: true,
                  },
                ],
                sends: [],
              },
              automation: [
                {
                  param: 'faderDb',
                  enabled: true,
                  points: [{ ppq: 1, value: -6 }],
                },
                {
                  param: 'insert:0:drive',
                  enabled: true,
                  points: [{ ppq: 2, value: 0.3 }],
                },
                {
                  param: 'insert:0:bypassTone',
                  enabled: true,
                  points: [{ ppq: 2, value: 1 }],
                },
                {
                  param: 'insert:1:drive',
                  enabled: true,
                  points: [{ ppq: 2, value: 0.9 }],
                },
              ],
            },
          ],
        },
        masterAutomation: [
          {
            param: 'pan',
            enabled: true,
            points: [{ ppq: 3, value: -0.5 }],
          },
          {
            param: 'insert:0:tiltDb',
            enabled: true,
            points: [{ ppq: 4, value: -1 }],
          },
          {
            param: 'insert:0:oversample',
            enabled: true,
            points: [{ ppq: 4, value: 1 }],
          },
          {
            param: 'insert:1:tiltDb',
            enabled: true,
            points: [{ ppq: 4, value: 3 }],
          },
        ],
      }),
    );
    const busLane = project.querySelector('Arrangement > Lanes > Lanes[track="bus-track-0"]');
    const masterLane = project.querySelector('Arrangement > Lanes > Lanes[track="master-track"]');

    expect(
      attr(busLane?.querySelector('Points[id="automation-bus-0-faderDb"] Target'), 'parameter'),
    ).toBe('bus-channel-0-volume');
    expect(
      attr(
        busLane?.querySelector('Points[id="automation-bus-0-insert_0_drive"] Target'),
        'parameter',
      ),
    ).toBe('bus-channel-0-insert-0-param-drive');
    expect(
      attr(masterLane?.querySelector('Points[id="automation-master-pan"] Target'), 'parameter'),
    ).toBe('master-channel-pan');
    expect(
      attr(
        masterLane?.querySelector('Points[id="automation-master-insert_0_tiltDb"] Target'),
        'parameter',
      ),
    ).toBe('master-channel-insert-0-param-tiltDb');
    expect(
      attr(
        busLane?.querySelector('Points[id="automation-bus-0-insert_0_bypassTone"] Target'),
        'parameter',
      ),
    ).toBe('bus-channel-0-insert-0-param-bypassTone');
    expect(busLane?.querySelector('Points[id="automation-bus-0-insert_1_drive"]')).toBeNull();
    expect(
      attr(
        masterLane?.querySelector('Points[id="automation-master-insert_0_oversample"] Target'),
        'parameter',
      ),
    ).toBe('master-channel-insert-0-param-oversample');
    expect(masterLane?.querySelector('Points[id="automation-master-insert_1_tiltDb"]')).toBeNull();
  });
});

describe('exportDawproject round-trip sanity', () => {
  it('represents every track, clip and note exactly once', async () => {
    const doc = makeDoc(
      [
        makeTrack([makeMidiClip(), makeMidiClip({ startPpq: 16, name: 'Second' })], {
          name: 'Keys',
        }),
        makeTrack([makeAudioClip()], { name: 'Vox', kind: 'audio' }),
        makeTrack([], { name: 'Empty' }),
      ],
      {
        markers: [{ ppq: 0, name: 'Top' }],
        sections: [{ name: 'A', color: '#112233', startPpq: 0, endPpq: 8 }],
      },
    );
    const project = await exportProjectXml(doc, {
      includeAudio: true,
      loadAudioAsset: makeAssetLoader(),
    });
    // 3 document tracks + the synthetic master track.
    expect(project.querySelectorAll('Structure > Track')).toHaveLength(4);
    expect(project.querySelectorAll('Arrangement Clips > Clip')).toHaveLength(3);
    expect(project.querySelectorAll('Note')).toHaveLength(4);
    expect(project.querySelectorAll('Audio')).toHaveLength(1);
    expect(project.querySelectorAll('Marker')).toHaveLength(2);
    // One Lanes element per track inside the arrangement lanes.
    expect(project.querySelectorAll('Arrangement > Lanes > Lanes')).toHaveLength(3);
    // Track names survive escaping and appear exactly once each.
    const names = [...project.querySelectorAll('Structure > Track')].map((t) =>
      t.getAttribute('name'),
    );
    expect(names).toEqual(['Keys', 'Vox', 'Empty', 'Master']);
  });

  it('produces deterministic bytes for the same document', async () => {
    const doc = makeDoc([makeTrack([makeMidiClip()])]);
    const a = await exportDawproject(doc, { includeAudio: false });
    const b = await exportDawproject(doc, { includeAudio: false });
    expect(a).toEqual(b);
  });
});

describe('dawprojectFilename', () => {
  it('appends the extension to a sanitized project name', () => {
    expect(dawprojectFilename('My Song')).toBe('My Song.dawproject');
    expect(dawprojectFilename('My: Song?')).toBe('My_ Song_.dawproject');
    expect(dawprojectFilename('a/b\\c')).toBe('a_b_c.dawproject');
  });

  it('falls back to "project" for empty names', () => {
    expect(dawprojectFilename('')).toBe(`project${DAWPROJECT_FILE_EXTENSION}`);
    expect(dawprojectFilename('   ')).toBe('project.dawproject');
  });
});

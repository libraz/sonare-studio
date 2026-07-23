import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it, vi } from 'vitest';
import {
  exportDawproject,
  importDawproject,
  importDawprojectWithMedia,
  importDawprojectWithMediaResult,
} from '@/export/dawproject';
import type { InsertSlot } from '@/project/mixer';
import type { DocumentClip, DocumentTrack, ProjectDocument } from '@/project/serialization';
import { normalizeTempoMap, ppqRangeSeconds } from '@/project/tempo-map';
import { bakeWarpedClip, warpSegments } from '@/project/warp';

function makeMidiClip(overrides: Partial<DocumentClip> = {}): DocumentClip {
  return {
    name: 'Phrase',
    startPpq: 4,
    lengthPpq: 8,
    sourceOffsetPpq: 2,
    gain: 1,
    loopEnabled: true,
    loopLengthPpq: 4,
    kind: 'midi',
    notes: [
      { pitch: 60, velocity: 127, startPpq: 2, durationPpq: 1, channel: 0 },
      { pitch: 64, velocity: 64, startPpq: 3, durationPpq: 0.5, channel: 1, offVelocity: 32 },
    ],
    ...overrides,
  };
}

function makeTrack(clips: DocumentClip[], overrides: Partial<DocumentTrack> = {}): DocumentTrack {
  return {
    name: 'Keys',
    color: '#60a5fa',
    kind: 'midi',
    mute: false,
    solo: false,
    volume: 0.75,
    pan: -0.25,
    clips,
    ...overrides,
  };
}

function makeDoc(overrides: Partial<ProjectDocument> = {}): ProjectDocument {
  return {
    schemaVersion: 3,
    name: 'Imported DAWproject',
    sampleRate: 48000,
    tempoSegments: [{ startPpq: 0, bpm: 120 }],
    timeSignatures: [{ startPpq: 0, numerator: 4, denominator: 4 }],
    tracks: [makeTrack([makeMidiClip()])],
    markers: [{ ppq: 8, name: 'Drop' }],
    sections: [],
    ...overrides,
  };
}

function makeExternalAudioDawproject(path: string): Uint8Array {
  return zipSync({
    'project.xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<Project version="1.0">
  <Application name="ExternalTest" version="1.0"/>
  <Transport id="transport">
    <Tempo id="tempo" unit="bpm" value="120"/>
    <TimeSignature id="meter" numerator="4" denominator="4"/>
  </Transport>
  <Structure>
    <Track id="track-0" name="Audio" contentType="audio" color="#60a5fa">
      <Channel id="channel-0" role="regular" audioChannels="2" solo="false">
        <Volume id="volume-0" unit="linear" min="0" max="2" value="1"/>
        <Pan id="pan-0" unit="normalized" min="0" max="1" value="0.5"/>
        <Mute id="mute-0" value="false"/>
      </Channel>
    </Track>
  </Structure>
  <Arrangement id="arrangement">
    <Lanes id="arrangement-lanes" timeUnit="beats">
      <Lanes id="lanes-0" track="track-0">
        <Clips id="clips-0">
          <Clip time="0" duration="4" contentTimeUnit="seconds" playStart="0.5" name="External Vox">
            <Audio id="audio-0" timeUnit="seconds" channels="2" sampleRate="48000" duration="1">
              <File path="${path}" external="true"/>
            </Audio>
          </Clip>
        </Clips>
      </Lanes>
    </Lanes>
  </Arrangement>
</Project>`),
  });
}

function rewriteProjectXml(bytes: Uint8Array, mutate: (project: Document) => void): Uint8Array {
  const entries = unzipSync(bytes);
  const project = new DOMParser().parseFromString(
    strFromU8(entries['project.xml']),
    'application/xml',
  );
  mutate(project);
  entries['project.xml'] = strToU8(new XMLSerializer().serializeToString(project));
  return zipSync(entries);
}

function makeRoutedDawproject(): Uint8Array {
  return zipSync({
    'project.xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<Project version="1.0">
  <Application name="RoutingTest" version="1.0"/>
  <Transport id="transport">
    <Tempo id="tempo" unit="bpm" value="120"/>
    <TimeSignature id="meter" numerator="4" denominator="4"/>
  </Transport>
  <Structure>
    <Track id="track-0" name="Dry" contentType="audio" color="#60a5fa">
      <Channel id="channel-dry" role="regular" audioChannels="2" solo="false" destination="channel-fx">
        <Volume id="volume-dry" unit="linear" min="0" max="2" value="1"/>
        <Pan id="pan-dry" unit="normalized" min="0" max="1" value="0.5"/>
        <Mute id="mute-dry" value="false"/>
        <Sends>
          <Send id="send-dry-fx" destination="channel-fx" type="pre">
            <Mute id="send-mute-dry-fx" value="false"/>
            <Volume id="send-volume-dry-fx" unit="linear" min="0" max="2" value="0.25"/>
          </Send>
        </Sends>
      </Channel>
    </Track>
    <Track id="track-1" name="FX Return" contentType="audio" color="#34d399">
      <Channel id="channel-fx" role="effect" audioChannels="2" solo="false" destination="master-channel">
        <Volume id="volume-fx" unit="linear" min="0" max="2" value="0.5"/>
        <Pan id="pan-fx" unit="normalized" min="0" max="1" value="0.75"/>
        <Mute id="mute-fx" value="false"/>
      </Channel>
    </Track>
    <Track id="master-track" name="Master" contentType="tracks">
      <Channel id="master-channel" role="master" audioChannels="2" solo="false"/>
    </Track>
  </Structure>
  <Arrangement id="arrangement">
    <Lanes id="arrangement-lanes" timeUnit="beats"/>
  </Arrangement>
</Project>`),
  });
}

function makeGroupedDawproject(): Uint8Array {
  return zipSync({
    'project.xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<Project version="1.0">
  <Application name="GroupTest" version="1.0"/>
  <Transport id="transport">
    <Tempo id="tempo" unit="bpm" value="120"/>
    <TimeSignature id="meter" numerator="4" denominator="4"/>
  </Transport>
  <Structure>
    <Track id="group-0" name="Drum Bus" contentType="tracks" color="#f97316">
      <Channel id="channel-group" role="regular" audioChannels="2" solo="false">
        <Volume id="volume-group" unit="linear" min="0" max="2" value="1"/>
        <Pan id="pan-group" unit="normalized" min="0" max="1" value="0.9"/>
        <Mute id="mute-group" value="false"/>
      </Channel>
      <Track id="track-kick" name="Kick" contentType="audio" color="#60a5fa">
        <Channel id="channel-kick" role="regular" audioChannels="2" solo="false">
          <Volume id="volume-kick" unit="linear" min="0" max="2" value="1"/>
          <Pan id="pan-kick" unit="normalized" min="0" max="1" value="0.5"/>
          <Mute id="mute-kick" value="false"/>
        </Channel>
      </Track>
    </Track>
    <Track id="master-track" name="Master" contentType="tracks">
      <Channel id="master-channel" role="master" audioChannels="2" solo="false"/>
    </Track>
  </Structure>
  <Arrangement id="arrangement">
    <Lanes id="arrangement-lanes" timeUnit="beats">
      <Lanes id="lanes-kick" track="track-kick">
        <Clips id="clips-kick">
          <Clip time="0" duration="4" name="Kick clip"/>
        </Clips>
      </Lanes>
    </Lanes>
  </Arrangement>
</Project>`),
  });
}

function makeUnsupportedInsertAutomationDawproject(): Uint8Array {
  return zipSync({
    'project.xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<Project version="1.0">
  <Application name="InsertBoundaryTest" version="1.0"/>
  <Transport id="transport">
    <Tempo id="tempo" unit="bpm" value="120"/>
    <TimeSignature id="meter" numerator="4" denominator="4"/>
  </Transport>
  <Structure>
    <Track id="track-0" name="Vox" contentType="audio" color="#60a5fa">
      <Channel id="channel-0" role="regular" audioChannels="2" solo="false">
        <Volume id="volume-0" unit="linear" min="0" max="2" value="1"/>
        <Pan id="pan-0" unit="normalized" min="0" max="1" value="0.5"/>
        <Mute id="mute-0" value="false"/>
        <Devices>
          <BuiltinDevice id="external-device" deviceVendor="external-vendor" deviceName="ExternalComp">
            <Parameters>
              <RealParameter id="external-threshold" name="thresholdDb" unit="dB" value="-18"/>
            </Parameters>
          </BuiltinDevice>
          <BuiltinDevice id="sonare-device" deviceVendor="sonare-studio" deviceName="dynamics.compressor" sonareSidechainSourceIndex="0">
            <Enabled id="sonare-device-enabled" value="true"/>
            <Parameters>
              <BoolParameter id="sonare-auto-makeup" name="autoMakeup" value="true"/>
            </Parameters>
          </BuiltinDevice>
        </Devices>
      </Channel>
    </Track>
  </Structure>
  <Arrangement id="arrangement">
    <Lanes id="arrangement-lanes" timeUnit="beats">
      <Lanes id="track-0-lanes" track="track-0">
        <Points id="external-insert-automation" unit="normalized">
          <Target parameter="external-threshold"/>
          <RealPoint time="1" value="-24" interpolation="linear"/>
        </Points>
        <Points id="bool-insert-automation" unit="bool">
          <Target parameter="sonare-auto-makeup"/>
          <RealPoint time="2" value="0" interpolation="hold"/>
        </Points>
      </Lanes>
    </Lanes>
  </Arrangement>
</Project>`),
  });
}

function makeNestedWarpDawproject(
  warpUnits: { timeUnit: string; contentTimeUnit: string } = {
    timeUnit: 'beats',
    contentTimeUnit: 'seconds',
  },
): Uint8Array {
  return zipSync({
    'audio/nested.wav': new Uint8Array([1, 2, 3, 4]),
    'project.xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<Project version="1.0">
  <Application name="Reference DAW" version="5.0"/>
  <Transport><Tempo value="120"/><TimeSignature numerator="4" denominator="4"/></Transport>
  <Structure>
    <Track id="audio-track" name="Nested Audio" contentType="audio">
      <Channel id="audio-channel" role="regular" audioChannels="2" solo="false">
        <Volume value="1"/><Pan value="0.5"/><Mute value="false"/>
      </Channel>
    </Track>
  </Structure>
  <Arrangement><Lanes timeUnit="beats"><Lanes track="audio-track"><Clips>
    <Clip time="4" duration="8" playStart="2" loopStart="2" loopEnd="10" name="Outer event">
      <Clips><Clip time="1" duration="12" contentTimeUnit="beats" playStart="3">
        <Warps timeUnit="${warpUnits.timeUnit}" contentTimeUnit="${warpUnits.contentTimeUnit}">
          <Audio timeUnit="seconds" channels="2" sampleRate="48000" duration="5">
            <File path="audio/nested.wav" external="false"/>
          </Audio>
          <Warp time="0" contentTime="0"/>
          <Warp time="4" contentTime="1"/>
          <Warp time="8" contentTime="2.5"/>
          <Warp time="12" contentTime="5"/>
        </Warps>
      </Clip></Clips>
    </Clip>
  </Clips></Lanes></Lanes></Arrangement>
</Project>`),
  });
}

describe('importDawproject', () => {
  it('rejects deeply nested project XML before constructing a DOM tree', () => {
    const depth = 129;
    const archive = zipSync({
      'project.xml': strToU8(`${'<Node>'.repeat(depth)}${'</Node>'.repeat(depth)}`),
    });

    expect(() => importDawproject(archive)).toThrow(/depth XML limit/);
  });

  it('imports the portable subset from a sonare-exported DAWproject archive', async () => {
    const exported = await exportDawproject(makeDoc(), { includeAudio: false });
    const imported = importDawproject(exported);

    expect(imported.name).toBe('Imported DAWproject');
    expect(imported.tempoSegments).toEqual([{ startPpq: 0, bpm: 120 }]);
    expect(imported.timeSignatures).toEqual([{ startPpq: 0, numerator: 4, denominator: 4 }]);
    expect(imported.markers).toEqual([{ ppq: 8, name: 'Drop' }]);
    expect(imported.tracks).toHaveLength(1);
    expect(imported.tracks[0]).toMatchObject({
      name: 'Keys',
      kind: 'midi',
      color: '#60a5fa',
      mute: false,
      solo: false,
      volume: 0.75,
      pan: -0.25,
    });
    expect(imported.tracks[0].clips[0]).toMatchObject({
      name: 'Phrase',
      startPpq: 4,
      lengthPpq: 8,
      sourceOffsetPpq: 2,
      loopEnabled: true,
      loopLengthPpq: 4,
      kind: 'midi',
    });
    expect(imported.tracks[0].clips[0].notes).toEqual([
      // The source note carries no off-velocity, so it must not gain one.
      { pitch: 60, velocity: 127, startPpq: 2, durationPpq: 1, channel: 0 },
      { pitch: 64, velocity: 64, startPpq: 3, durationPpq: 0.5, channel: 1, offVelocity: 32 },
    ]);
  });

  it('imports tempo ramps and time-signature automation points', async () => {
    const exported = await exportDawproject(
      makeDoc({
        tempoSegments: [
          { startPpq: 0, bpm: 120, endBpm: 140 },
          { startPpq: 8, bpm: 96 },
        ],
        timeSignatures: [
          { startPpq: 0, numerator: 4, denominator: 4 },
          { startPpq: 16, numerator: 7, denominator: 8 },
        ],
      }),
      { includeAudio: false },
    );
    const imported = importDawproject(exported);

    expect(imported.tempoSegments).toEqual([
      { startPpq: 0, bpm: 120, endBpm: 140 },
      { startPpq: 8, bpm: 96 },
    ]);
    expect(imported.timeSignatures).toEqual([
      { startPpq: 0, numerator: 4, denominator: 4 },
      { startPpq: 16, numerator: 7, denominator: 8 },
    ]);
  });

  it('keeps a final open-ended tempo ramp idempotent across round-trips', async () => {
    const readTempoPoints = (bytes: Uint8Array): Array<[number, number, string | null]> => {
      const project = new DOMParser().parseFromString(
        strFromU8(unzipSync(bytes)['project.xml']),
        'application/xml',
      );
      return [...project.querySelectorAll('Arrangement > TempoAutomation > RealPoint')].map(
        (point) => [
          Number(point.getAttribute('time')),
          Number(point.getAttribute('value')),
          point.getAttribute('interpolation'),
        ],
      );
    };
    const doc = makeDoc({ tempoSegments: [{ startPpq: 0, bpm: 120, endBpm: 140 }] });
    const exported1 = await exportDawproject(doc, { includeAudio: false });
    const imported1 = importDawproject(exported1);
    const exported2 = await exportDawproject(imported1, { includeAudio: false });

    // The open-ended ramp emits a single linear start and one hold terminator.
    expect(readTempoPoints(exported1)).toHaveLength(2);
    // Re-exporting the imported ramp must not accrete a duplicate terminator
    // point at the content end.
    expect(readTempoPoints(exported2)).toEqual(readTempoPoints(exported1));
  });

  it('round-trips MIDI expression lanes from clip-local Points', async () => {
    const exported = await exportDawproject(
      makeDoc({
        tracks: [
          makeTrack([
            makeMidiClip({
              ccLanes: [
                {
                  channel: 1,
                  controller: 11,
                  points: [
                    { ppq: 0, value: 32 },
                    { ppq: 2, value: 96, curve: 'linear' },
                  ],
                },
              ],
              pitchBendLanes: [{ channel: 2, points: [{ ppq: 1, value: 8192 }] }],
              programChangeLanes: [{ channel: 3, points: [{ ppq: 1.5, program: 24 }] }],
              channelPressureLanes: [{ channel: 4, points: [{ ppq: 2.5, value: 80 }] }],
              polyPressureLanes: [{ channel: 5, pitch: 64, points: [{ ppq: 3.5, value: 70 }] }],
            }),
          ]),
        ],
      }),
      { includeAudio: false },
    );

    const clip = importDawproject(exported).tracks[0].clips[0];

    expect(clip.ccLanes).toEqual([
      {
        channel: 1,
        controller: 11,
        points: [
          { ppq: 0, value: 32 },
          { ppq: 2, value: 96, curve: 'linear' },
        ],
      },
    ]);
    expect(clip.pitchBendLanes).toEqual([{ channel: 2, points: [{ ppq: 1, value: 8192 }] }]);
    expect(clip.programChangeLanes).toEqual([{ channel: 3, points: [{ ppq: 1.5, program: 24 }] }]);
    expect(clip.channelPressureLanes).toEqual([{ channel: 4, points: [{ ppq: 2.5, value: 80 }] }]);
    expect(clip.polyPressureLanes).toEqual([
      { channel: 5, pitch: 64, points: [{ ppq: 3.5, value: 70 }] },
    ]);
  });

  it('imports audio clips as placement-only clips without media ingest', async () => {
    const exported = await exportDawproject(
      makeDoc({
        tracks: [
          makeTrack(
            [
              {
                name: 'Vox',
                startPpq: 0,
                lengthPpq: 4,
                sourceOffsetPpq: 0,
                gain: 1,
                loopEnabled: false,
                loopLengthPpq: 0,
                kind: 'audio',
                assetId: 'vox',
                notes: [],
                fadeInPpq: 0.25,
              },
            ],
            { name: 'Audio', kind: 'audio' },
          ),
        ],
      }),
      { includeAudio: false },
    );
    const clip = importDawproject(exported).tracks[0].clips[0];

    expect(clip).toMatchObject({
      name: 'Vox',
      startPpq: 0,
      lengthPpq: 4,
      kind: 'audio',
      notes: [],
      fadeInPpq: 0.25,
    });
    expect(clip.assetId).toBeUndefined();
  });

  it('round-trips trimmed loops across a tempo ramp using one content origin', async () => {
    const clip: DocumentClip = {
      name: 'Ramp trim',
      startPpq: 6,
      lengthPpq: 4,
      sourceOffsetPpq: 3,
      gain: 1,
      loopEnabled: true,
      loopLengthPpq: 2,
      kind: 'audio',
      assetId: 'ramp-trim',
      notes: [],
      fadeInPpq: 0.75,
      fadeOutPpq: 1.25,
    };
    const exported = await exportDawproject(
      makeDoc({
        tempoSegments: [
          { startPpq: 0, bpm: 120, endBpm: 72 },
          { startPpq: 8, bpm: 90 },
        ],
        tracks: [makeTrack([clip], { kind: 'audio' })],
      }),
      { includeAudio: false },
    );

    const imported = importDawproject(exported).tracks[0].clips[0];
    expect(imported.sourceOffsetPpq).toBeCloseTo(3, 9);
    expect(imported.loopEnabled).toBe(true);
    expect(imported.loopLengthPpq).toBeCloseTo(2, 9);
    expect(imported.fadeInPpq).toBeCloseTo(0.75, 9);
    expect(imported.fadeOutPpq).toBeCloseTo(1.25, 9);
  });

  it('converts seconds fades at their respective clip edges', async () => {
    const tempoSegments = [
      { startPpq: 0, bpm: 120, endBpm: 72 },
      { startPpq: 8, bpm: 90 },
    ];
    const clip: DocumentClip = {
      name: 'Seconds fades',
      startPpq: 6,
      lengthPpq: 4,
      sourceOffsetPpq: 3,
      gain: 1,
      loopEnabled: true,
      loopLengthPpq: 2,
      kind: 'audio',
      assetId: 'seconds-fades',
      notes: [],
      fadeInPpq: 0.75,
      fadeOutPpq: 1.25,
    };
    const exported = await exportDawproject(
      makeDoc({ tempoSegments, tracks: [makeTrack([clip], { kind: 'audio' })] }),
      { includeAudio: false },
    );
    const tempoMap = normalizeTempoMap(tempoSegments);
    const rewritten = rewriteProjectXml(exported, (project) => {
      const element = project.querySelector('Arrangement Clip');
      if (!element) throw new Error('missing test clip');
      element.setAttribute('fadeTimeUnit', 'seconds');
      element.setAttribute(
        'fadeInTime',
        String(ppqRangeSeconds(tempoMap, clip.startPpq, clip.startPpq + 0.75)),
      );
      element.setAttribute(
        'fadeOutTime',
        String(
          ppqRangeSeconds(
            tempoMap,
            clip.startPpq + clip.lengthPpq - 1.25,
            clip.startPpq + clip.lengthPpq,
          ),
        ),
      );
    });

    const imported = importDawproject(rewritten).tracks[0].clips[0];
    expect(imported.sourceOffsetPpq).toBeCloseTo(3, 9);
    expect(imported.loopLengthPpq).toBeCloseTo(2, 9);
    expect(imported.fadeInPpq).toBeCloseTo(0.75, 9);
    expect(imported.fadeOutPpq).toBeCloseTo(1.25, 9);
  });

  it('reports unsupported audio content and fade time units as import losses', async () => {
    const exported = await exportDawproject(
      makeDoc({
        tracks: [
          makeTrack(
            [
              {
                name: 'Odd units',
                startPpq: 2,
                lengthPpq: 4,
                sourceOffsetPpq: 1,
                gain: 1,
                loopEnabled: false,
                loopLengthPpq: 0,
                kind: 'audio',
                assetId: 'odd-units',
                notes: [],
                fadeInPpq: 0.5,
              },
            ],
            { kind: 'audio' },
          ),
        ],
      }),
      { includeAudio: false },
    );
    const rewritten = rewriteProjectXml(exported, (project) => {
      const element = project.querySelector('Arrangement Clip');
      if (!element) throw new Error('missing test clip');
      element.setAttribute('contentTimeUnit', 'samples');
      element.setAttribute('fadeTimeUnit', 'ticks');
    });

    const result = await importDawprojectWithMediaResult(rewritten, {
      ingestAudio: async () => ({ id: 'unused' }),
    });
    expect(result.losses).toEqual([
      {
        kind: 'unsupported-time-unit',
        clipName: 'Odd units',
        attribute: 'contentTimeUnit',
        unit: 'samples',
      },
      {
        kind: 'unsupported-time-unit',
        clipName: 'Odd units',
        attribute: 'fadeTimeUnit',
        unit: 'ticks',
      },
    ]);
  });

  it('recursively composes nested clip placement and imports Warps', async () => {
    const result = await importDawprojectWithMediaResult(makeNestedWarpDawproject(), {
      ingestAudio: async () => ({ id: 'nested-asset' }),
    });

    expect(result.losses).toEqual([]);
    expect(result.media.imported).toEqual(['audio/nested.wav']);
    expect(result.document.tracks[0].clips).toEqual([
      {
        name: 'Outer event',
        startPpq: 4,
        lengthPpq: 8,
        sourceOffsetPpq: 2,
        gain: 1,
        loopEnabled: true,
        loopLengthPpq: 8,
        kind: 'audio',
        notes: [],
        assetId: 'nested-asset',
        warp: {
          enabled: true,
          sourceBpm: 120,
          anchors: [{ ppq: 4, sourceSeconds: 1.5 }],
        },
      },
    ]);
    const importedClip = result.document.tracks[0].clips[0];
    expect(warpSegments(importedClip)).toEqual([
      {
        ppq: 0,
        lengthPpq: 4,
        sourceStartSeconds: 1,
        sourceLengthSeconds: 1.5,
      },
      {
        ppq: 4,
        lengthPpq: 4,
        sourceStartSeconds: 2.5,
        sourceLengthSeconds: 2.5,
      },
    ]);

    const source = Float32Array.from({ length: 50 }, (_, index) => index);
    const stretch = vi.fn((samples: Float32Array, _sampleRate: number, rate: number) =>
      new Float32Array(Math.round(samples.length / rate)).fill(samples[0] ?? 0),
    );
    const [baked] = await bakeWarpedClip([source], 10, importedClip, 120, { stretch });
    expect(stretch.mock.calls.map(([samples, , rate]) => [samples.length, rate])).toEqual([
      [15, 0.75],
      [25, 1.25],
    ]);
    expect([...baked.slice(0, 20)]).toEqual(new Array(20).fill(10));
    expect([...baked.slice(20, 40)]).toEqual(new Array(20).fill(25));
  });

  it('reports unsupported nested Warp units before the document is loaded', async () => {
    const result = await importDawprojectWithMediaResult(
      makeNestedWarpDawproject({ timeUnit: 'seconds', contentTimeUnit: 'beats' }),
      { ingestAudio: async () => ({ id: 'nested-asset' }) },
    );

    expect(result.losses).toEqual([
      {
        kind: 'unsupported-warp',
        clipName: 'Outer event',
        reason: 'time-units',
        timeUnit: 'seconds',
        contentTimeUnit: 'beats',
      },
    ]);
    expect(result.document.tracks[0].clips[0].warp).toBeUndefined();
  });

  it('round-trips Sonare audio Warp points without changing their mapping', async () => {
    const clip: DocumentClip = {
      name: 'Warped loop',
      startPpq: 3,
      lengthPpq: 6,
      sourceOffsetPpq: 2,
      gain: 1,
      loopEnabled: true,
      loopLengthPpq: 3,
      kind: 'audio',
      assetId: 'warped-audio',
      notes: [],
      warp: {
        enabled: true,
        sourceBpm: 100,
        anchors: [{ ppq: 2, sourceSeconds: 1.5 }],
      },
    };
    const exported = await exportDawproject(
      makeDoc({ tracks: [makeTrack([clip], { kind: 'audio' })] }),
      { includeAudio: false },
    );
    const xml = new DOMParser().parseFromString(
      strFromU8(unzipSync(exported)['project.xml']),
      'application/xml',
    );
    expect(xml.querySelector('Arrangement Warps')).not.toBeNull();
    expect(
      [...xml.querySelectorAll('Arrangement Warps > Warp')].map((point) => ({
        time: Number(point.getAttribute('time')),
        contentTime: Number(point.getAttribute('contentTime')),
      })),
    ).toEqual([
      { time: 0, contentTime: 1.2 },
      { time: 2, contentTime: 2.7 },
      { time: 6, contentTime: 4.8 },
    ]);

    const imported = importDawproject(exported).tracks[0].clips[0];
    expect(imported).toMatchObject({
      startPpq: 3,
      lengthPpq: 6,
      loopEnabled: true,
      loopLengthPpq: 3,
      warp: { enabled: true },
    });
    expect(imported.sourceOffsetPpq).toBeCloseTo(2, 9);
    expect(imported.warp?.sourceBpm).toBeCloseTo(100, 9);
    expect(imported.warp?.anchors?.[0].ppq).toBeCloseTo(2, 9);
    expect(imported.warp?.anchors?.[0].sourceSeconds).toBeCloseTo(1.5, 9);
  });

  it('ingests embedded internal audio files and assigns clip asset ids', async () => {
    const exported = await exportDawproject(
      makeDoc({
        tracks: [
          makeTrack(
            [
              {
                name: 'Vox A',
                startPpq: 0,
                lengthPpq: 4,
                sourceOffsetPpq: 1,
                gain: 1,
                loopEnabled: true,
                loopLengthPpq: 2,
                kind: 'audio',
                assetId: 'vox',
                notes: [],
              },
              {
                name: 'Vox B',
                startPpq: 8,
                lengthPpq: 4,
                sourceOffsetPpq: 0,
                gain: 1,
                loopEnabled: false,
                loopLengthPpq: 0,
                kind: 'audio',
                assetId: 'vox',
                notes: [],
              },
            ],
            { name: 'Audio', kind: 'audio' },
          ),
        ],
      }),
      {
        includeAudio: true,
        loadAudioAsset: async (assetId: string) => ({
          meta: {
            id: assetId,
            name: assetId,
            sampleRate: 48000,
            numChannels: 1,
            numFrames: 48000,
          },
          channels: [new Float32Array(48000)],
        }),
      },
    );
    const ingestAudio = vi.fn(async () => ({ id: 'ingested-vox' }));

    const imported = await importDawprojectWithMedia(exported, { ingestAudio });
    const clips = imported.tracks[0].clips;

    expect(ingestAudio).toHaveBeenCalledTimes(1);
    expect(ingestAudio.mock.calls[0][0]).toMatchObject({
      path: 'audio/vox.wav',
      name: 'vox',
    });
    expect(ingestAudio.mock.calls[0][0].bytes.length).toBeGreaterThan(44);
    expect(clips[0]).toMatchObject({
      assetId: 'ingested-vox',
      sourceOffsetPpq: 1,
      loopEnabled: true,
      loopLengthPpq: 2,
    });
    expect(clips[1].assetId).toBe('ingested-vox');
  });

  it('keeps audio clips placement-only when embedded media ingest fails', async () => {
    const exported = await exportDawproject(
      makeDoc({
        tracks: [
          makeTrack(
            [
              {
                name: 'Vox',
                startPpq: 0,
                lengthPpq: 4,
                sourceOffsetPpq: 0,
                gain: 1,
                loopEnabled: false,
                loopLengthPpq: 0,
                kind: 'audio',
                assetId: 'vox',
                notes: [],
              },
            ],
            { name: 'Audio', kind: 'audio' },
          ),
        ],
      }),
      {
        includeAudio: true,
        loadAudioAsset: async (assetId: string) => ({
          meta: {
            id: assetId,
            name: assetId,
            sampleRate: 48000,
            numChannels: 1,
            numFrames: 48000,
          },
          channels: [new Float32Array(48000)],
        }),
      },
    );

    const imported = await importDawprojectWithMedia(exported, {
      ingestAudio: async () => {
        throw new Error('decode failed');
      },
    });

    expect(imported.tracks[0].clips[0].assetId).toBeUndefined();
    expect(imported.tracks[0].clips[0]).toMatchObject({
      name: 'Vox',
      kind: 'audio',
      startPpq: 0,
      lengthPpq: 4,
    });
  });

  it('returns structured media failures instead of silently reporting full success', async () => {
    const result = await importDawprojectWithMediaResult(
      makeExternalAudioDawproject('/Missing/Vox.wav'),
      { resolveExternalAudio: async () => null },
    );

    expect(result.document.tracks[0].clips[0].assetId).toBeUndefined();
    expect(result.media).toEqual({
      imported: [],
      issues: [{ path: '/Missing/Vox.wav', external: true, reason: 'missing' }],
    });
    expect(result.losses).toEqual([]);
  });

  it('resolves external audio files through an injected resolver', async () => {
    const bytes = new Uint8Array([9, 8, 7, 6]);
    const resolveExternalAudio = vi.fn(async () => bytes);
    const ingestAudio = vi.fn(async () => ({ id: 'external-asset' }));

    const imported = await importDawprojectWithMedia(
      makeExternalAudioDawproject('/Session Audio/Vox.wav'),
      { resolveExternalAudio, ingestAudio },
    );
    const clip = imported.tracks[0].clips[0];

    expect(resolveExternalAudio).toHaveBeenCalledWith('/Session Audio/Vox.wav');
    expect(ingestAudio).toHaveBeenCalledWith({
      path: '/Session Audio/Vox.wav',
      external: true,
      name: 'Vox',
      bytes,
    });
    expect(clip).toMatchObject({
      name: 'External Vox',
      assetId: 'external-asset',
      sourceOffsetPpq: 1,
    });
  });

  it('imports effect-channel destinations as mixer bus output routing', () => {
    const imported = importDawproject(makeRoutedDawproject());

    expect(imported.mixer?.buses).toEqual([
      {
        id: 'daw-bus-1',
        name: 'FX Return',
        gainDb: expect.closeTo(-6.0206, 4),
        strip: { gainDb: 0, pan: 0.5, inserts: [], sends: [] },
      },
    ]);
    expect(imported.tracks).toHaveLength(1);
    expect(imported.tracks[0]).toMatchObject({
      name: 'Dry',
      mixer: {
        gainDb: 0,
        pan: 0,
        inserts: [],
        sends: [
          {
            busId: 'daw-bus-1',
            levelDb: expect.closeTo(-12.0412, 4),
            enabled: true,
            timing: 'preFader',
          },
        ],
        outputBusId: 'daw-bus-1',
      },
    });
  });

  it('keeps foreign effect returns canonical across repeated round-trips', async () => {
    const first = importDawproject(makeRoutedDawproject());
    expect(first.tracks).toHaveLength(1);
    expect(first.mixer?.buses).toHaveLength(1);

    const second = importDawproject(await exportDawproject(first, { includeAudio: false }));
    const third = importDawproject(await exportDawproject(second, { includeAudio: false }));
    for (const document of [second, third]) {
      expect(document.tracks).toHaveLength(1);
      expect(document.mixer?.buses).toHaveLength(1);
      expect(document.mixer?.buses[0].name).toBe('FX Return');
    }
  });

  it('reads a track with sends from its own channel Volume, not the first send', async () => {
    // The exporter emits a channel's <Sends> (each carrying a nested <Volume>)
    // before the channel's own <Volume>. A descendant query would grab the
    // send's Volume as the track fader, corrupting gain and dropping fader
    // automation that targets the real channel Volume id.
    const first = importDawproject(makeRoutedDawproject());
    expect(first.tracks[0].mixer?.sends).toHaveLength(1);
    // Give the Dry track a distinctive fader gain (0.5) and fader automation;
    // the send level is a different 0.25, so a mix-up is unambiguous.
    first.tracks[0].volume = 0.5;
    first.tracks[0].automation = [
      { param: 'faderDb', enabled: true, points: [{ ppq: 2, value: -6 }] },
    ];

    const second = importDawproject(await exportDawproject(first, { includeAudio: false }));

    expect(second.tracks).toHaveLength(1);
    expect(second.tracks[0].volume).toBeCloseTo(0.5, 4);
    const faderLane = second.tracks[0].automation?.find((lane) => lane.param === 'faderDb');
    expect(faderLane).toBeDefined();
    expect(faderLane?.points[0]).toMatchObject({ ppq: 2, value: expect.closeTo(-6, 3) });
  });

  it('preserves Sonare aux-track identity without converting it into a mixer bus', async () => {
    const source = makeDoc({ tracks: [makeTrack([], { name: 'Aux track', kind: 'aux' })] });
    const imported = importDawproject(await exportDawproject(source, { includeAudio: false }));
    expect(imported.tracks).toHaveLength(1);
    expect(imported.tracks[0]).toMatchObject({ name: 'Aux track', kind: 'aux' });
    expect(imported.mixer?.buses ?? []).toEqual([]);
  });

  it('imports nested tracks under contentType=tracks as group membership', () => {
    const imported = importDawproject(makeGroupedDawproject());

    expect(imported.tracks).toHaveLength(2);
    expect(imported.tracks[0]).toMatchObject({
      name: 'Drum Bus',
      kind: 'group',
      pan: 0,
    });
    expect(imported.tracks[1]).toMatchObject({
      name: 'Kick',
      kind: 'audio',
      groupIndex: 0,
    });
    expect(imported.tracks[1].clips[0]).toMatchObject({
      name: 'Kick clip',
      kind: 'audio',
    });
  });

  it('round-trips sonare VCA groups and member assignments without double-applying gain', async () => {
    const exported = await exportDawproject(
      makeDoc({
        tracks: [
          makeTrack([], {
            name: 'Member',
            volume: 0.75,
            vcaId: 'vca-1',
            mixer: { gainDb: -3, pan: 0, inserts: [], sends: [] },
          }),
          makeTrack([], { name: 'Dry', volume: 0.5 }),
        ],
        mixer: {
          master: { gainDb: 0, pan: 0, inserts: [], sends: [] },
          buses: [],
          vcaGroups: [{ id: 'vca-1', name: 'Band VCA', gainDb: -6, mute: true, solo: true }],
        },
      }),
      { includeAudio: false },
    );

    const imported = importDawproject(exported);

    expect(imported.mixer?.vcaGroups).toEqual([
      { id: 'vca-1', name: 'Band VCA', gainDb: -6, mute: true, solo: true },
    ]);
    expect(imported.tracks[0]).toMatchObject({
      name: 'Member',
      volume: 0.75,
      vcaId: 'vca-1',
      mixer: { gainDb: -3 },
    });
    expect(imported.tracks[1]).toMatchObject({
      name: 'Dry',
      volume: 0.5,
    });
    expect(imported.tracks[1].vcaId).toBeUndefined();
  });

  it('round-trips sonare BuiltinDevice insert chains on tracks, buses and master', async () => {
    const exported = await exportDawproject(
      makeDoc({
        tracks: [
          makeTrack([], {
            mixer: {
              gainDb: 0,
              pan: 0,
              inserts: [
                {
                  processor: 'dynamics.compressor',
                  params: { thresholdDb: -18, autoMakeup: true },
                  enabled: false,
                  sidechainSourceIndex: 0,
                } as InsertSlot & { sidechainSourceIndex: number },
              ],
              sends: [],
              outputBusId: 'bus-1',
            },
            automation: [
              { param: 'faderDb', enabled: true, points: [{ ppq: 1, value: -6 }] },
              { param: 'pan', enabled: true, points: [{ ppq: 2, value: 0.5 }] },
              {
                param: 'insert:0:thresholdDb',
                enabled: true,
                points: [{ ppq: 3, value: -24 }],
              },
            ],
          }),
        ],
        mixer: {
          master: {
            gainDb: 0,
            pan: 0,
            inserts: [
              {
                processor: 'eq.tilt',
                params: { tiltDb: 1.5 },
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
              gainDb: -3,
              strip: {
                gainDb: 0,
                pan: 0,
                inserts: [
                  {
                    processor: 'saturation.tape',
                    params: { drive: 0.7 },
                    enabled: true,
                    sidechainSourceIndex: 0,
                  } as InsertSlot & { sidechainSourceIndex: number },
                ],
                sends: [],
              },
              automation: [
                { param: 'faderDb', enabled: true, points: [{ ppq: 4, value: -12 }] },
                { param: 'insert:0:drive', enabled: true, points: [{ ppq: 5, value: 0.3 }] },
              ],
            },
          ],
        },
        masterAutomation: [
          { param: 'pan', enabled: true, points: [{ ppq: 6, value: -0.5 }] },
          { param: 'insert:0:tiltDb', enabled: true, points: [{ ppq: 7, value: -1 }] },
        ],
      }),
      { includeAudio: false },
    );

    const imported = importDawproject(exported);

    expect(imported.tracks[0].mixer?.inserts).toEqual([
      {
        processor: 'dynamics.compressor',
        params: { thresholdDb: -18, autoMakeup: true },
        enabled: false,
        sidechainSourceIndex: 0,
      },
    ]);
    expect(imported.mixer?.buses[0].strip?.inserts).toEqual([
      {
        processor: 'saturation.tape',
        params: { drive: 0.7 },
        enabled: true,
        sidechainSourceIndex: 0,
      },
    ]);
    expect(imported.mixer?.master.inserts).toEqual([
      { processor: 'eq.tilt', params: { tiltDb: 1.5 }, enabled: true, sidechainSourceIndex: 0 },
    ]);
    expect(imported.tracks[0].mixer?.inserts[0].sidechainSourceTrackId).toBeUndefined();
    expect(imported.mixer?.buses[0].strip?.inserts[0].sidechainSourceTrackId).toBeUndefined();
    expect(imported.mixer?.master.inserts[0].sidechainSourceTrackId).toBeUndefined();
    expect(
      (
        imported.mixer?.buses[0].strip?.inserts[0] as InsertSlot & {
          sidechainSourceIndex?: number;
        }
      ).sidechainSourceIndex,
    ).toBe(0);
    expect(
      (imported.mixer?.master.inserts[0] as InsertSlot & { sidechainSourceIndex?: number })
        .sidechainSourceIndex,
    ).toBe(0);
    expect(imported.tracks[0].automation).toEqual([
      {
        param: 'faderDb',
        enabled: true,
        points: [{ ppq: 1, value: expect.closeTo(-6, 5), curve: 'linear' }],
      },
      { param: 'pan', enabled: true, points: [{ ppq: 2, value: 0.5, curve: 'linear' }] },
      {
        param: 'insert:0:thresholdDb',
        enabled: true,
        points: [{ ppq: 3, value: -24, curve: 'linear' }],
      },
    ]);
    expect(imported.mixer?.buses[0].automation).toEqual([
      {
        param: 'faderDb',
        enabled: true,
        points: [{ ppq: 4, value: expect.closeTo(-12, 5), curve: 'linear' }],
      },
      { param: 'insert:0:drive', enabled: true, points: [{ ppq: 5, value: 0.3, curve: 'linear' }] },
    ]);
    expect(imported.masterAutomation).toEqual([
      { param: 'pan', enabled: true, points: [{ ppq: 6, value: -0.5, curve: 'linear' }] },
      { param: 'insert:0:tiltDb', enabled: true, points: [{ ppq: 7, value: -1, curve: 'linear' }] },
    ]);
  });

  it('preserves a master fader and pan even when it has no inserts', async () => {
    const source = makeDoc({
      mixer: { master: { gainDb: -6, pan: -0.5, inserts: [], sends: [] }, buses: [] },
    });

    const imported = importDawproject(await exportDawproject(source, { includeAudio: false }));

    expect(imported.mixer?.master.gainDb).toBeCloseTo(-6, 8);
    expect(imported.mixer?.master.pan).toBe(-0.5);
  });

  it('ignores external insert devices and imports sonare boolean insert automation', () => {
    const imported = importDawproject(makeUnsupportedInsertAutomationDawproject());

    expect(imported.tracks[0].mixer?.inserts).toEqual([
      {
        processor: 'dynamics.compressor',
        params: { autoMakeup: true },
        enabled: true,
        sidechainSourceIndex: 0,
      },
    ]);
    expect(imported.tracks[0].automation).toEqual([
      {
        param: 'insert:0:autoMakeup',
        enabled: true,
        points: [{ ppq: 2, value: 0, curve: 'hold' }],
      },
    ]);
  });

  it('drops group track target insert sidechain metadata on import', () => {
    const archive = zipSync({
      'project.xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<Project version="1.0">
  <Application name="ImportTest" version="1.0"/>
  <Transport id="transport">
    <Tempo id="tempo" unit="bpm" value="120"/>
    <TimeSignature id="meter" numerator="4" denominator="4"/>
  </Transport>
  <Structure>
    <Track id="track-0" name="Drum Bus" contentType="tracks" color="#60a5fa">
      <Channel id="channel-0" role="regular" audioChannels="2" solo="false">
        <Volume id="volume-0" unit="linear" min="0" max="2" value="1"/>
        <Pan id="pan-0" unit="normalized" min="0" max="1" value="0.5"/>
        <Mute id="mute-0" value="false"/>
        <Devices>
          <BuiltinDevice id="insert-0" deviceName="dynamics.compressor" deviceRole="audioFX" deviceVendor="sonare-studio" loaded="true" sonareSidechainSourceIndex="1">
            <Parameters>
              <RealParameter id="threshold" name="thresholdDb" unit="normalized" value="-18"/>
            </Parameters>
            <Enabled id="enabled" value="true"/>
          </BuiltinDevice>
        </Devices>
      </Channel>
      <Track id="track-1" name="Kick" contentType="audio" color="#60a5fa">
        <Channel id="channel-1" role="regular" audioChannels="2" solo="false">
          <Volume id="volume-1" unit="linear" min="0" max="2" value="1"/>
          <Pan id="pan-1" unit="normalized" min="0" max="1" value="0.5"/>
          <Mute id="mute-1" value="false"/>
        </Channel>
      </Track>
    </Track>
    <Track id="track-2" name="Key Source" contentType="audio" color="#60a5fa">
      <Channel id="channel-2" role="regular" audioChannels="2" solo="false">
        <Volume id="volume-2" unit="linear" min="0" max="2" value="1"/>
        <Pan id="pan-2" unit="normalized" min="0" max="1" value="0.5"/>
        <Mute id="mute-2" value="false"/>
      </Channel>
    </Track>
  </Structure>
</Project>`),
    });

    const imported = importDawproject(archive);

    expect(imported.tracks[0].kind).toBe('group');
    expect(imported.tracks[0].mixer?.inserts).toEqual([
      {
        processor: 'dynamics.compressor',
        params: { thresholdDb: -18 },
        enabled: true,
      },
    ]);
  });

  it('drops out-of-range insert sidechain source indexes on import', () => {
    const archive = zipSync({
      'project.xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<Project version="1.0">
  <Application name="ImportTest" version="1.0"/>
  <Transport id="transport">
    <Tempo id="tempo" unit="bpm" value="120"/>
    <TimeSignature id="meter" numerator="4" denominator="4"/>
  </Transport>
  <Structure>
    <Track id="track-0" name="Dry" contentType="audio" color="#60a5fa">
      <Channel id="channel-0" role="regular" audioChannels="2" solo="false" destination="bus-channel-0">
        <Volume id="volume-0" unit="linear" min="0" max="2" value="1"/>
        <Pan id="pan-0" unit="normalized" min="0" max="1" value="0.5"/>
        <Mute id="mute-0" value="false"/>
        <Devices>
          <BuiltinDevice id="track-insert-0" deviceName="dynamics.compressor" deviceRole="audioFX" deviceVendor="sonare-studio" loaded="true" sonareSidechainSourceIndex="99">
            <Enabled id="track-enabled" value="true"/>
          </BuiltinDevice>
        </Devices>
      </Channel>
    </Track>
    <Track id="track-1" name="Key Source" contentType="audio" color="#60a5fa">
      <Channel id="channel-1" role="regular" audioChannels="2" solo="false">
        <Volume id="volume-1" unit="linear" min="0" max="2" value="1"/>
        <Pan id="pan-1" unit="normalized" min="0" max="1" value="0.5"/>
        <Mute id="mute-1" value="false"/>
      </Channel>
    </Track>
    <Track id="bus-track-0" name="Return" contentType="audio">
      <Channel id="bus-channel-0" role="effect" audioChannels="2" solo="false">
        <Volume id="bus-volume-0" unit="linear" min="0" max="2" value="1"/>
        <Pan id="bus-pan-0" unit="normalized" min="0" max="1" value="0.5"/>
        <Mute id="bus-mute-0" value="false"/>
        <Devices>
          <BuiltinDevice id="bus-insert-0" deviceName="saturation.tape" deviceRole="audioFX" deviceVendor="sonare-studio" loaded="true" sonareSidechainSourceIndex="99">
            <Enabled id="bus-enabled" value="true"/>
          </BuiltinDevice>
        </Devices>
      </Channel>
    </Track>
    <Track id="master-track" name="Master" contentType="tracks">
      <Channel id="master-channel" role="master" audioChannels="2" solo="false">
        <Volume id="master-volume" unit="linear" min="0" max="2" value="1"/>
        <Pan id="master-pan" unit="normalized" min="0" max="1" value="0.5"/>
        <Mute id="master-mute" value="false"/>
        <Devices>
          <BuiltinDevice id="master-insert-0" deviceName="eq.tilt" deviceRole="audioFX" deviceVendor="sonare-studio" loaded="true" sonareSidechainSourceIndex="99">
            <Enabled id="master-enabled" value="true"/>
          </BuiltinDevice>
        </Devices>
      </Channel>
    </Track>
  </Structure>
</Project>`),
    });

    const imported = importDawproject(archive);

    expect(imported.tracks[0].mixer?.inserts).toEqual([
      { processor: 'dynamics.compressor', params: {}, enabled: true },
    ]);
    expect(imported.mixer?.buses[0].strip?.inserts).toEqual([
      { processor: 'saturation.tape', params: {}, enabled: true },
    ]);
    expect(imported.mixer?.master.inserts).toEqual([
      { processor: 'eq.tilt', params: {}, enabled: true },
    ]);
  });

  it('rejects unreadable archives and archives without project.xml', () => {
    expect(() => importDawproject(new Uint8Array([1, 2, 3]))).toThrow('not a readable zip');
    const zip = zipSync({ 'metadata.xml': strToU8('<MetaData/>') });
    expect(() => importDawproject(zip)).toThrow('missing project.xml');
  });
});

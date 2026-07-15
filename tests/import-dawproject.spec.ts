import { strToU8, zipSync } from 'fflate';
import { describe, expect, it, vi } from 'vitest';
import {
  exportDawproject,
  importDawproject,
  importDawprojectWithMedia,
  importDawprojectWithMediaResult,
} from '@/export/dawproject';
import type { InsertSlot } from '@/project/mixer';
import type { DocumentClip, DocumentTrack, ProjectDocument } from '@/project/serialization';

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
        <Pan id="pan-group" unit="normalized" min="0" max="1" value="0.5"/>
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

describe('importDawproject', () => {
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
      pan: 0,
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
      { pitch: 60, velocity: 127, startPpq: 2, durationPpq: 1, channel: 0, offVelocity: 127 },
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
          { ppq: 2, value: 96 },
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
    expect(imported.tracks).toHaveLength(2);
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
    expect(imported.tracks[1]).toMatchObject({
      name: 'FX Return',
      kind: 'aux',
    });
  });

  it('imports nested tracks under contentType=tracks as group membership', () => {
    const imported = importDawproject(makeGroupedDawproject());

    expect(imported.tracks).toHaveLength(2);
    expect(imported.tracks[0]).toMatchObject({
      name: 'Drum Bus',
      kind: 'group',
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
          makeTrack([], { name: 'Member', volume: 0.75, vcaId: 'vca-1' }),
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

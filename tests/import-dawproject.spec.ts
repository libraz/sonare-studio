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
import { warpedClipSource, warpSegments } from '@/project/warp';

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
  <Transport>
    <Tempo id="tempo" unit="bpm" value="120"/>
    <TimeSignature id="meter" numerator="4" denominator="4"/>
  </Transport>
  <Structure>
    <Track id="track-0" name="Audio" contentType="audio" color="#60a5fa">
      <Channel id="channel-0" role="regular" audioChannels="2" solo="false">
        <Mute id="mute-0" value="false"/>
        <Pan id="pan-0" unit="normalized" min="0" max="1" value="0.5"/>
        <Volume id="volume-0" unit="linear" min="0" max="2" value="1"/>
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

/**
 * Builds schema-valid official MIDI-expression forms. A DAWproject Clip has a
 * content choice, so each expression Point timeline is its own Points-only
 * Clip rather than an invalid Notes+Points hybrid. Track timelines exercise
 * the sibling `<Arrangement><Lanes><Points track="…">` form DAWs emit.
 */
function makeMidiExpressionDawproject(
  clipPoints: readonly string[],
  trackPoints: readonly string[] = [],
): Uint8Array {
  const clips = clipPoints
    .map(
      (points, index) => `
          <Clip time="${index * 8}" duration="8" name="Expression clip">
            ${points}
          </Clip>`,
    )
    .join('');
  const arrangementPoints = trackPoints
    .map((points) => points.replace('<Points', '<Points track="track-0"'))
    .join('');
  return zipSync({
    'project.xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<Project version="1.0">
  <Application name="ExpressionTest" version="1.0"/>
  <Transport>
    <Tempo id="tempo" unit="bpm" value="120"/>
    <TimeSignature id="meter" numerator="4" denominator="4"/>
  </Transport>
  <Structure>
    <Track id="track-0" name="Expression" contentType="notes" color="#60a5fa">
      <Channel id="channel-0" role="regular" audioChannels="2" solo="false">
        <Mute id="mute-0" value="false"/>
        <Pan id="pan-0" unit="normalized" min="0" max="1" value="0.5"/>
        <Volume id="volume-0" unit="linear" min="0" max="2" value="1"/>
      </Channel>
    </Track>
  </Structure>
  <Arrangement id="arrangement">
    <Lanes id="arrangement-lanes" timeUnit="beats">
      <Lanes id="lanes-0" track="track-0">
        <Clips id="clips-0">
          ${clips}
        </Clips>
      </Lanes>
      ${arrangementPoints}
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

  it('holds a final segment with a stale end tempo, idempotently across round-trips', async () => {
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

    // Playback holds the final segment, so no ramp is written for it.
    expect(readTempoPoints(exported1)).toEqual([]);
    expect(imported1.tempoSegments.map((segment) => segment.bpm)).toEqual([120]);
    // Re-exporting must not accrete tempo points.
    expect(readTempoPoints(exported2)).toEqual(readTempoPoints(exported1));
  });

  it('imports official Target expression MIDI lanes with normalized and raw values in both paths', async () => {
    const archive = makeMidiExpressionDawproject([
      `<Points id="cc-normalized" unit="normalized">
        <Target expression="channelController" channel="1" controller="11"/>
        <RealPoint time="0" value="0.5"/>
      </Points>`,
      `<Points id="cc-raw" unit="linear">
        <Target expression="channelController" channel="2" controller="74"/>
        <RealPoint time="1" value="32" interpolation="linear"/>
      </Points>`,
      `<Points id="pitch-normalized" unit="normalized">
        <Target expression="pitchBend" channel="3"/>
        <RealPoint time="2" value="0.5"/>
      </Points>`,
      `<Points id="channel-pressure" unit="normalized">
        <Target expression="channelPressure" channel="4"/>
        <RealPoint time="3" value="0.5"/>
      </Points>`,
      `<Points id="poly-pressure" unit="normalized">
        <Target expression="polyPressure" channel="5" key="64"/>
        <RealPoint time="4" value="0.5"/>
      </Points>`,
      `<Points id="program-change">
        <Target expression="programChange" channel="6"/>
        <IntegerPoint time="5" value="24"/>
      </Points>`,
    ]);

    const direct = importDawproject(archive);
    const worker = await importDawprojectWithMediaResult(archive, {
      ingestAudio: vi.fn(async () => ({ id: 'unused' })),
    });

    expect(worker.document).toEqual(direct);
    expect(worker.losses).toEqual([]);
    const clips = direct.tracks[0].clips;
    expect(clips).toHaveLength(6);
    expect(clips[0]).toMatchObject({
      kind: 'midi',
      notes: [],
      ccLanes: [{ channel: 1, controller: 11, points: [{ ppq: 0, value: 64 }] }],
    });
    expect(clips[1]).toMatchObject({
      ccLanes: [{ channel: 2, controller: 74, points: [{ ppq: 1, value: 32, curve: 'linear' }] }],
    });
    expect(clips[2]).toMatchObject({
      pitchBendLanes: [{ channel: 3, points: [{ ppq: 2, value: 8192 }] }],
    });
    expect(clips[3]).toMatchObject({
      channelPressureLanes: [{ channel: 4, points: [{ ppq: 3, value: 64 }] }],
    });
    expect(clips[4]).toMatchObject({
      polyPressureLanes: [{ channel: 5, pitch: 64, points: [{ ppq: 4, value: 64 }] }],
    });
    expect(clips[5]).toMatchObject({
      programChangeLanes: [{ channel: 6, points: [{ ppq: 5, program: 24 }] }],
    });
  });

  it('imports official track-targeted MIDI expression Points in both paths', async () => {
    const archive = makeMidiExpressionDawproject(
      [],
      [
        `<Points id="track-cc" unit="normalized">
        <Target expression="channelController" channel="3" controller="1"/>
        <RealPoint time="0" value="0" interpolation="linear"/>
        <RealPoint time="8" value="1" interpolation="hold"/>
      </Points>`,
      ],
    );

    const direct = importDawproject(archive);
    const worker = await importDawprojectWithMediaResult(archive, {
      ingestAudio: vi.fn(async () => ({ id: 'unused' })),
    });

    expect(worker.document).toEqual(direct);
    expect(worker.losses).toEqual([]);
    expect(direct.tracks[0].clips).toEqual([
      expect.objectContaining({
        kind: 'midi',
        notes: [],
        startPpq: 0,
        lengthPpq: 8,
        ccLanes: [
          {
            channel: 3,
            controller: 1,
            points: [
              { ppq: 0, value: 0, curve: 'linear' },
              { ppq: 8, value: 127 },
            ],
          },
        ],
      }),
    ]);
  });

  it('keeps legacy dotted MIDI expression parameters working with raw values', async () => {
    const archive = makeMidiExpressionDawproject([
      `<Points id="legacy-cc">
        <Target parameter="midi.cc.2.11"/>
        <RealPoint time="0" value="96"/>
      </Points>`,
      `<Points id="legacy-pitch">
        <Target parameter="midi.pitchBend.3"/>
        <RealPoint time="1" value="4096"/>
      </Points>`,
      `<Points id="legacy-program">
        <Target parameter="midi.program.4"/>
        <RealPoint time="2" value="7"/>
      </Points>`,
    ]);

    const result = await importDawprojectWithMediaResult(archive);

    expect(result.losses).toEqual([]);
    expect(result.document.tracks[0].clips[0]).toMatchObject({
      ccLanes: [{ channel: 2, controller: 11, points: [{ ppq: 0, value: 96 }] }],
    });
    expect(result.document.tracks[0].clips[1]).toMatchObject({
      pitchBendLanes: [{ channel: 3, points: [{ ppq: 1, value: 4096 }] }],
    });
    expect(result.document.tracks[0].clips[2]).toMatchObject({
      programChangeLanes: [{ channel: 4, points: [{ ppq: 2, program: 7 }] }],
    });
  });

  it('reports malformed and unknown non-empty MIDI expression lanes as losses', async () => {
    const archive = makeMidiExpressionDawproject([
      `<Points id="missing-controller" unit="normalized">
        <Target expression="channelController" channel="1"/>
        <RealPoint time="0" value="0.5"/>
      </Points>`,
      `<Points id="unknown-expression" unit="normalized">
        <Target expression="timbre" channel="1"/>
        <RealPoint time="1" value="0.5"/>
      </Points>`,
      `<Points id="wrong-point-type">
        <Target expression="pitchBend" channel="1"/>
        <IntegerPoint time="2" value="8192"/>
      </Points>`,
      `<Points id="malformed-point" unit="normalized">
        <Target expression="channelPressure" channel="1"/>
        <RealPoint time="not-a-time" value="0.5"/>
      </Points>`,
    ]);

    const result = await importDawprojectWithMediaResult(archive);

    expect(result.losses).toEqual([
      {
        kind: 'unsupported-midi-expression',
        clipName: 'Expression clip',
        expression: 'channelController',
        reason: 'missing-controller',
      },
      {
        kind: 'unsupported-midi-expression',
        clipName: 'Expression clip',
        expression: 'timbre',
        reason: 'unknown-expression',
      },
      {
        kind: 'unsupported-midi-expression',
        clipName: 'Expression clip',
        expression: 'pitchBend',
        reason: 'unsupported-point-type',
      },
      {
        kind: 'unsupported-midi-expression',
        clipName: 'Expression clip',
        expression: 'channelPressure',
        reason: 'unsupported-point-type',
      },
    ]);
    for (const clip of result.document.tracks[0].clips) {
      expect(clip).not.toHaveProperty('ccLanes');
      expect(clip).not.toHaveProperty('pitchBendLanes');
      expect(clip).not.toHaveProperty('channelPressureLanes');
    }
  });

  it('keeps MIDI expression out of portable XML and round-trips it in vendor metadata', async () => {
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

    const projectXml = strFromU8(unzipSync(exported)['project.xml']);
    expect(projectXml).not.toContain('midi-7bit');
    expect(projectXml).not.toContain('midi-14bit');
    expect(projectXml).not.toContain('midi-program');
    expect(projectXml).not.toContain('midi.cc.');
    expect(
      new DOMParser().parseFromString(projectXml, 'application/xml').querySelector('Clip > Points'),
    ).toBeNull();

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

  it('binds Sonare metadata by track ids across nested groups in sync and worker imports', async () => {
    const childExpression = makeMidiClip({
      ccLanes: [{ channel: 1, controller: 11, points: [{ ppq: 0, value: 32 }] }],
      pitchBendLanes: [{ channel: 2, points: [{ ppq: 1, value: 8192 }] }],
      programChangeLanes: [{ channel: 3, points: [{ ppq: 2, program: 24 }] }],
      channelPressureLanes: [{ channel: 4, points: [{ ppq: 3, value: 80 }] }],
      polyPressureLanes: [{ channel: 5, pitch: 64, points: [{ ppq: 4, value: 70 }] }],
    });
    const source = makeDoc({
      // Deliberately place the nested child before its parent. Exporting the
      // DAWproject must nest it, so import traversal order differs from this
      // document order and positional metadata associations would drift.
      tracks: [
        makeTrack([childExpression], {
          name: 'Nested Child',
          mixer: {
            gainDb: 0,
            pan: 0,
            inserts: [
              {
                processor: 'dynamics.compressor',
                params: { thresholdDb: -18 },
                enabled: true,
                // The source index points at the group (track-1), whose
                // traversal index becomes zero after nesting.
                sidechainSourceIndex: 1,
              } as InsertSlot & { sidechainSourceIndex: number },
            ],
            sends: [],
          },
          kind: 'midi',
          groupIndex: 1,
        }),
        makeTrack([], { name: 'Nested Group', kind: 'group' }),
        makeTrack([], { name: 'Key Source', kind: 'audio' }),
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
              sidechainSourceIndex: 1,
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
    });

    const exported = await exportDawproject(source, { includeAudio: false });
    const sync = importDawproject(exported);
    const worker = await importDawprojectWithMediaResult(exported, {
      ingestAudio: vi.fn(async () => ({ id: 'unused' })),
    });

    expect(worker.document).toEqual(sync);
    expect(sync.tracks.map((track) => track.name)).toEqual([
      'Nested Group',
      'Nested Child',
      'Key Source',
    ]);
    expect(sync.tracks[1].groupIndex).toBe(0);
    expect(sync.tracks[1].clips[0]).toMatchObject({
      ccLanes: childExpression.ccLanes,
      pitchBendLanes: childExpression.pitchBendLanes,
      programChangeLanes: childExpression.programChangeLanes,
      channelPressureLanes: childExpression.channelPressureLanes,
      polyPressureLanes: childExpression.polyPressureLanes,
    });
    const childInsert = sync.tracks[1].mixer?.inserts[0] as InsertSlot & {
      sidechainSourceIndex?: number;
    };
    const busInsert = sync.mixer?.buses[0].strip?.inserts[0] as InsertSlot & {
      sidechainSourceIndex?: number;
    };
    const masterInsert = sync.mixer?.master.inserts[0] as InsertSlot & {
      sidechainSourceIndex?: number;
    };
    expect(childInsert.sidechainSourceIndex).toBe(0);
    expect(busInsert.sidechainSourceIndex).toBe(1);
    expect(masterInsert.sidechainSourceIndex).toBe(0);
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

  it('skips disabled arrangement clips and records an explicit loss', async () => {
    const exported = await exportDawproject(makeDoc(), { includeAudio: false });
    const rewritten = rewriteProjectXml(exported, (project) => {
      const element = project.querySelector('Arrangement Clip');
      if (!element) throw new Error('missing test clip');
      element.setAttribute('enable', '0');
    });

    const result = await importDawprojectWithMediaResult(rewritten);
    expect(result.document.tracks[0]?.clips).toEqual([]);
    expect(result.losses).toEqual([{ kind: 'disabled-clip', clipName: 'Phrase' }]);
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
    // The engine stretches the 1 s..5 s source slice through both segments.
    const warped = warpedClipSource([source], 10, importedClip, 120);
    expect(warped?.channels[0][0]).toBe(10);
    expect(warped?.anchors).toEqual([
      { warpSample: 0, sourceSample: 0 },
      { warpSample: 20, sourceSample: 15 },
      { warpSample: 40, sourceSample: 40 },
    ]);
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

  it('refuses a seconds-based arrangement before media ingestion, including tempo changes', async () => {
    const exported = await exportDawproject(
      makeDoc({
        tempoSegments: [
          { startPpq: 0, bpm: 120 },
          { startPpq: 16, bpm: 90, endBpm: 60 },
        ],
      }),
      { includeAudio: false },
    );
    const secondsBased = rewriteProjectXml(exported, (project) => {
      project.querySelector('Arrangement > Lanes')?.setAttribute('timeUnit', 'seconds');
    });
    const ingestAudio = vi.fn(async () => ({ id: 'should-not-import' }));

    expect(() => importDawproject(secondsBased)).toThrow(
      /Unsupported DAWproject arrangement timeUnit "seconds"/,
    );
    await expect(importDawprojectWithMediaResult(secondsBased, { ingestAudio })).rejects.toThrow(
      /import refused to preserve timing/,
    );
    expect(ingestAudio).not.toHaveBeenCalled();
  });

  it('rejects a seconds time context at every arrangement boundary', async () => {
    const exported = await exportDawproject(makeDoc(), { includeAudio: false });
    for (const selector of ['Arrangement', 'Arrangement > Lanes']) {
      const rewritten = rewriteProjectXml(exported, (project) => {
        project.querySelector(selector)?.setAttribute('timeUnit', 'seconds');
      });
      expect(() => importDawproject(rewritten)).toThrow(/import refused to preserve timing/);
    }
  });

  it('inherits a disabled parent clip when flattening nested events', async () => {
    const disabledParent = rewriteProjectXml(makeNestedWarpDawproject(), (project) => {
      project.querySelector('Arrangement Clip')?.setAttribute('enable', 'false');
    });

    const result = await importDawprojectWithMediaResult(disabledParent, {
      ingestAudio: async () => ({ id: 'must-not-import' }),
    });

    expect(result.document.tracks[0]?.clips).toEqual([]);
    expect(result.losses).toEqual([{ kind: 'disabled-clip', clipName: 'Outer event' }]);
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

  it('round-trips Sonare arrangement sections without polluting markers', async () => {
    const imported = importDawproject(
      await exportDawproject(
        makeDoc({
          sections: [{ name: 'Chorus', color: '#123456', startPpq: 4, endPpq: 12 }],
        }),
        { includeAudio: false },
      ),
    );

    expect(imported.sections).toEqual([
      { name: 'Chorus', color: '#123456', startPpq: 4, endPpq: 12 },
    ]);
    expect(imported.markers).toEqual([{ ppq: 8, name: 'Drop' }]);
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

  it('accepts XSD 1/0 boolean attributes for audio files, channels, and devices', async () => {
    const externalArchive = rewriteProjectXml(
      makeExternalAudioDawproject('/Session Audio/Vox.wav'),
      (project) => project.querySelector('File')?.setAttribute('external', '1'),
    );
    const resolveExternalAudio = vi.fn(async () => new Uint8Array([9]));
    await importDawprojectWithMedia(externalArchive, {
      resolveExternalAudio,
      ingestAudio: async () => ({ id: 'external-asset' }),
    });
    expect(resolveExternalAudio).toHaveBeenCalledWith('/Session Audio/Vox.wav');

    const channelArchive = rewriteProjectXml(
      makeUnsupportedInsertAutomationDawproject(),
      (project) => {
        project.querySelector('Channel')?.setAttribute('solo', '1');
        project.querySelector('Mute')?.setAttribute('value', '1');
        project.querySelector('Enabled')?.setAttribute('value', '0');
        project.querySelector('BoolParameter')?.setAttribute('value', '1');
      },
    );
    const imported = importDawproject(channelArchive);

    expect(imported.tracks[0]).toMatchObject({ mute: true, solo: true });
    expect(imported.tracks[0].mixer?.inserts).toEqual([
      {
        processor: 'dynamics.compressor',
        params: { autoMakeup: true },
        enabled: false,
        sidechainSourceIndex: 0,
      },
    ]);
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
      pan: 0.8,
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

  it('inverts the exported VCA offset exactly once for fader automation', async () => {
    const source = makeDoc({
      tracks: [
        makeTrack([], {
          name: 'VCA Member',
          volume: 0.75,
          vcaId: 'vca-1',
          mixer: { gainDb: -3, pan: 0, inserts: [], sends: [] },
          automation: [
            {
              param: 'faderDb',
              enabled: true,
              points: [
                { ppq: 0, value: -120, curve: 'linear' },
                { ppq: 4, value: -119, curve: 'linear' },
                { ppq: 8, value: -114, curve: 'linear' },
                { ppq: 12, value: -113, curve: 'hold' },
                { ppq: 16, value: -10, curve: 'linear' },
              ],
            },
          ],
        }),
      ],
      mixer: {
        master: { gainDb: 0, pan: 0, inserts: [], sends: [] },
        buses: [],
        vcaGroups: [{ id: 'vca-1', name: 'Mix VCA', gainDb: -6 }],
      },
    });

    const exported = await exportDawproject(source, { includeAudio: false });
    const once = importDawproject(exported);
    const worker = await importDawprojectWithMediaResult(exported);
    const twice = importDawproject(await exportDawproject(once, { includeAudio: false }));

    expect(once.tracks[0].automation).toEqual(source.tracks[0].automation);
    expect(worker.document.tracks[0].automation).toEqual(source.tracks[0].automation);
    expect(twice.tracks[0].automation).toEqual(source.tracks[0].automation);
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
        imported.mixer!.buses[0].strip!.inserts[0] as InsertSlot & {
          sidechainSourceIndex?: number;
        }
      ).sidechainSourceIndex,
    ).toBe(0);
    expect(
      (imported.mixer!.master.inserts[0] as InsertSlot & { sidechainSourceIndex?: number })
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

  it('keeps a routed track strip pan aligned with the track pan', async () => {
    const source = makeDoc({
      tracks: [
        makeTrack([makeMidiClip()], {
          pan: 0.6,
          mixer: {
            gainDb: 0,
            pan: 0.6,
            inserts: [{ processor: 'eq.tilt', params: { tiltDb: 1 }, enabled: true }],
            sends: [],
          },
        }),
      ],
    });

    const imported = importDawproject(await exportDawproject(source, { includeAudio: false }));

    expect(imported.tracks[0].pan).toBeCloseTo(0.6, 8);
    expect(imported.tracks[0].mixer?.pan).toBeCloseTo(0.6, 8);
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

  it('reports foreign devices, unmapped sends, unmapped automation and orphan lanes', async () => {
    const exported = await exportDawproject(makeDoc(), { includeAudio: false });
    const rewritten = rewriteProjectXml(exported, (project) => {
      const channel = project.querySelector('Track[id="track-0"] > Channel');
      if (!channel) throw new Error('missing channel');
      let devices = Array.from(channel.children).find((child) => child.tagName === 'Devices');
      if (!devices) {
        devices = project.createElement('Devices');
        channel.appendChild(devices);
      }
      const plugin = project.createElement('Vst3Plugin');
      plugin.setAttribute('deviceName', 'Pro-Q');
      devices.appendChild(plugin);
      let sends = Array.from(channel.children).find((child) => child.tagName === 'Sends');
      if (!sends) {
        sends = project.createElement('Sends');
        channel.appendChild(sends);
      }
      const send = project.createElement('Send');
      send.setAttribute('destination', 'nowhere');
      sends.appendChild(send);
      const trackLanes = project.querySelector('Arrangement > Lanes > Lanes[track="track-0"]');
      const points = project.createElement('Points');
      const target = project.createElement('Target');
      target.setAttribute('parameter', 'plugin-param-7');
      const point = project.createElement('RealPoint');
      point.setAttribute('time', '0');
      point.setAttribute('value', '0.5');
      points.append(target, point);
      trackLanes?.appendChild(points);
      const orphan = project.createElement('Lanes');
      orphan.setAttribute('track', 'ghost');
      const orphanPoints = points.cloneNode(true) as Element;
      orphan.appendChild(orphanPoints);
      project.querySelector('Arrangement > Lanes')?.appendChild(orphan);
    });

    const result = await importDawprojectWithMediaResult(rewritten);

    expect(result.loss.entries).toEqual([
      { kind: 'foreign-device', count: 1, details: ['Keys: Pro-Q'] },
      { kind: 'unmapped-automation', count: 1, details: ['Keys: plugin-param-7'] },
      { kind: 'unmapped-send', count: 1, details: ['Keys: nowhere'] },
      { kind: 'orphan-lane', count: 1, details: ['ghost'] },
    ]);
  });

  it('reports MIDI content and automation timed in seconds instead of reading them as beats', async () => {
    const exported = await exportDawproject(
      makeDoc({
        tracks: [
          makeTrack([makeMidiClip()], {
            automation: [
              {
                param: 'pan',
                enabled: true,
                points: [{ ppq: 4, value: 0.5, curve: 'linear' }],
              },
            ],
          }),
        ],
      }),
      { includeAudio: false },
    );
    const rewritten = rewriteProjectXml(exported, (project) => {
      project.querySelector('Arrangement Clip')?.setAttribute('contentTimeUnit', 'seconds');
      for (const points of Array.from(project.querySelectorAll('Arrangement Points'))) {
        if (points.closest('Clip')) continue;
        points.setAttribute('timeUnit', 'seconds');
      }
    });

    const result = await importDawprojectWithMediaResult(rewritten);

    expect(result.document.tracks[0].clips).toEqual([]);
    expect(result.document.tracks[0].automation).toBeUndefined();
    expect(result.loss.entries).toEqual([
      {
        kind: 'unsupported-time-unit',
        count: 2,
        details: ['Phrase: contentTimeUnit=seconds', 'Keys: timeUnit=seconds'],
      },
    ]);
  });

  it('round-trips the pickup length and SMF SysEx through the Sonare sidecar', async () => {
    const sysEx = [{ ppq: 0, status: 0xf0 as const, data: [0x41, 0x10, 0x42, 0xf7] }];
    const exported = await exportDawproject(
      makeDoc({
        pickupLengthPpq: 1,
        tracks: [makeTrack([makeMidiClip({ smfSysEx: sysEx })])],
      }),
      { includeAudio: false },
    );

    const imported = importDawproject(exported);

    expect(imported.pickupLengthPpq).toBe(1);
    expect(imported.tracks[0].clips[0].smfSysEx).toEqual(sysEx);
  });

  it('rejects unreadable archives and archives without project.xml', () => {
    expect(() => importDawproject(new Uint8Array([1, 2, 3]))).toThrow('not a readable zip');
    const zip = zipSync({ 'metadata.xml': strToU8('<MetaData/>') });
    expect(() => importDawproject(zip)).toThrow('missing project.xml');
  });

  it('rejects unreadable archives and archives without project.xml on the worker path', async () => {
    await expect(importDawprojectWithMediaResult(new Uint8Array([1, 2, 3]))).rejects.toThrow(
      'not a readable zip',
    );
    const zip = zipSync({ 'metadata.xml': strToU8('<MetaData/>') });
    await expect(importDawprojectWithMediaResult(zip)).rejects.toThrow('missing project.xml');
  });
});

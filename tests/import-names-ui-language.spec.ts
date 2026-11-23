import { strToU8, zipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppSettings } from '@/composables/useAppSettings';
import { importDawproject } from '@/export/dawproject';
import { importMusicXml } from '@/notation/musicxml-import';
import { decodeAudioFile } from '@/project/audio-import';
import { midiFileToProjectDocument } from '@/project/smf-import';
import { coreWasmBinary } from './core-package';

vi.mock('@/lib/wasm', async () => {
  const wasm = await import('@libraz/libsonare');
  let module: typeof wasm | null = null;
  return {
    ensureWasm: async () => {
      if (!module) {
        await wasm.init({ wasmBinary: coreWasmBinary() } as Parameters<typeof wasm.init>[0]);
        module = wasm;
      }
      return module;
    },
  };
});

/** Format-0 SMF whose only track holds no events. */
const EMPTY_SMF = new Uint8Array([
  0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0x01, 0xe0, 0x4d, 0x54, 0x72, 0x6b, 0, 0, 0, 4,
  0x00, 0xff, 0x2f, 0x00,
]);

const UNNAMED_DAWPROJECT = zipSync({
  'project.xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<Project version="1.0">
  <Transport>
    <Tempo id="tempo" unit="bpm" value="120"/>
    <TimeSignature id="meter" numerator="4" denominator="4"/>
  </Transport>
  <Structure>
    <Track id="track-0" contentType="notes" color="#60a5fa">
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
          <Clip time="0" duration="4">
            <Notes id="notes-0">
              <Note time="0" duration="1" key="60" vel="0.8"/>
            </Notes>
          </Clip>
        </Clips>
      </Lanes>
    </Lanes>
    <Markers id="markers">
      <Marker time="2"/>
    </Markers>
  </Arrangement>
</Project>`),
});

const UNNAMED_MUSICXML = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list><score-part id=""/></part-list>
  <part id=""><measure number="1"/></part>
</score-partwise>`;

describe('import fallback names in the UI language', () => {
  const settings = useAppSettings();
  const previous = settings.settings.language;
  beforeEach(() => settings.set('language', 'ja'));
  afterEach(() => {
    settings.set('language', previous);
    vi.unstubAllGlobals();
  });

  it('names an empty SMF import in Japanese', async () => {
    const doc = await midiFileToProjectDocument(EMPTY_SMF);
    expect(doc.name).toBe('読み込んだ MIDI');
    expect(doc.tracks[0].clips[0].name).toBe('MIDI クリップ');
  });

  it('names an unnamed DAWproject import in Japanese', () => {
    const doc = importDawproject(UNNAMED_DAWPROJECT);
    expect(doc.name).toBe('読み込んだ DAWproject');
    expect(doc.tracks[0].name).toBe('トラック 1');
    // A notes clip under an unnamed placement takes the MIDI clip name, not the audio one.
    expect(doc.tracks[0].clips[0].name).toBe('MIDI クリップ');
    expect(doc.markers[0].name).toBe('マーカー');
  });

  it('names an unnamed audio import in Japanese', async () => {
    class FakeOfflineContext {
      decodeAudioData = async () => ({
        numberOfChannels: 1,
        length: 4,
        sampleRate: 48000,
        getChannelData: () => new Float32Array(4),
      });
    }
    vi.stubGlobal('OfflineAudioContext', FakeOfflineContext);
    const decoded = await decodeAudioFile(new ArrayBuffer(8));
    expect(decoded.name).toBe('読み込んだオーディオ');
  });

  it('names an unnamed MusicXML import in Japanese', () => {
    const doc = importMusicXml(UNNAMED_MUSICXML);
    expect(doc.name).toBe('読み込んだ MusicXML');
    expect(doc.tracks[0].name).toBe('パート 1');
  });
});

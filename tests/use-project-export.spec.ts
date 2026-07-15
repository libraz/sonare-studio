import { flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { confirmDialog } from '@/composables/useDialogs';
import { useProjectExport } from '@/composables/useProjectExport';
import { saveMixerSnapshot } from '@/project/command/mixer-snapshots';
import { addTrack } from '@/project/commands';
import { DEFAULT_MIDI_FX_CONFIG } from '@/project/midi-fx';
import {
  loadProjectDocument,
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  type ProjectDocument,
} from '@/project/serialization';
import { useProjectStore } from '@/project/store';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

vi.mock('@/composables/useDialogs', () => ({
  confirmDialog: vi.fn(),
}));

function makeDoc(kind: 'midi' | 'audio' = 'midi'): ProjectDocument {
  return {
    schemaVersion: PROJECT_DOCUMENT_SCHEMA_VERSION,
    name: 'Score Export',
    sampleRate: 48000,
    tempoSegments: [{ startPpq: 0, bpm: 120 }],
    timeSignatures: [{ startPpq: 0, numerator: 4, denominator: 4 }],
    tracks: [
      {
        name: 'Keys',
        color: '#60a5fa',
        kind,
        mute: false,
        solo: false,
        volume: 1,
        pan: 0,
        clips: [
          {
            name: 'Phrase',
            startPpq: 0,
            lengthPpq: 4,
            sourceOffsetPpq: 0,
            gain: 1,
            loopEnabled: false,
            loopLengthPpq: 0,
            kind,
            notes:
              kind === 'midi'
                ? [{ pitch: 60, velocity: 100, startPpq: 0, durationPpq: 1, channel: 0 }]
                : [],
            ...(kind === 'audio' ? { assetId: 'asset-1' } : {}),
          },
        ],
      },
    ],
    markers: [],
    sections: [],
  };
}

function setup() {
  const downloadBlobFile = vi.fn();
  const closeProjectMenu = vi.fn();
  const projectExport = useProjectExport({
    closeProjectMenu,
    downloadBlobFile,
    loopEnabled: ref(false),
    loopStartPpq: ref(0),
    loopEndPpq: ref(0),
    runAction: async (action) => {
      await action();
    },
  });
  return { closeProjectMenu, downloadBlobFile, projectExport };
}

describe('useProjectExport', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    useProjectStore().dispose();
    vi.mocked(confirmDialog).mockReset();
  });

  it('exports the active MIDI clip as MusicXML from the file menu action', async () => {
    await loadProjectDocument(makeDoc('midi'));
    const { closeProjectMenu, downloadBlobFile, projectExport } = setup();

    projectExport.exportMusicXmlAction();
    await flushPromises();

    expect(closeProjectMenu).toHaveBeenCalledTimes(1);
    expect(downloadBlobFile).toHaveBeenCalledTimes(1);
    const [blob, filename] = downloadBlobFile.mock.calls[0] as [Blob, string];
    expect(filename).toBe('Score Export.musicxml');
    await expect(blob.text()).resolves.toContain('<score-partwise version="4.0">');
  });

  it('does not export MusicXML when the active clip is audio', async () => {
    await loadProjectDocument(makeDoc('audio'));
    const { downloadBlobFile, projectExport } = setup();

    projectExport.exportMusicXmlAction();
    await flushPromises();

    expect(downloadBlobFile).not.toHaveBeenCalled();
  });

  it('exports DAWproject without prompting when the document has no lossy items', async () => {
    await loadProjectDocument(makeDoc('midi'));
    const { downloadBlobFile, projectExport } = setup();

    projectExport.exportDawprojectAction();
    await flushPromises();
    await vi.waitFor(() => expect(downloadBlobFile).toHaveBeenCalledTimes(1));

    expect(confirmDialog).not.toHaveBeenCalled();
    expect(downloadBlobFile).toHaveBeenCalledTimes(1);
    const [, filename] = downloadBlobFile.mock.calls[0] as [Blob, string];
    expect(filename).toBe('Score Export.dawproject');
  });

  it('exports DAWproject without prompting for supported boolean insert automation', async () => {
    await loadProjectDocument(makeDoc('midi'));
    const store = useProjectStore();
    const keyTrackId = addTrack({ name: 'Key Source', kind: 'audio' });
    store.tracks[0].mixer = {
      gainDb: 0,
      pan: 0,
      inserts: [
        {
          processor: 'dynamics.compressor',
          params: { autoMakeup: true },
          enabled: true,
          sidechainSourceTrackId: keyTrackId,
        },
      ],
      sends: [],
    };
    store.automationLanes = [
      {
        target: store.tracks[0].id,
        param: 'insert:0:autoMakeup',
        points: [
          { ppq: 0, value: 1, curve: 'hold' },
          { ppq: 2, value: 0 },
        ],
        enabled: true,
      },
    ];
    const { downloadBlobFile, projectExport } = setup();

    projectExport.exportDawprojectAction();
    await flushPromises();
    await vi.waitFor(() => expect(downloadBlobFile).toHaveBeenCalledTimes(1));

    expect(confirmDialog).not.toHaveBeenCalled();
    expect(downloadBlobFile).toHaveBeenCalledTimes(1);
    const [, filename] = downloadBlobFile.mock.calls[0] as [Blob, string];
    expect(filename).toBe('Score Export.dawproject');
  });

  it('exports DAWproject without prompting for supported bus and master insert sidechains', async () => {
    await loadProjectDocument(makeDoc('midi'));
    const store = useProjectStore();
    const keyTrackId = addTrack({ name: 'Key Source', kind: 'audio' });
    store.mixer.master.inserts = [
      {
        processor: 'dynamics.compressor',
        params: { thresholdDb: -12 },
        enabled: true,
        sidechainSourceTrackId: keyTrackId,
      },
    ];
    store.mixer.buses = [
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
              sidechainSourceTrackId: keyTrackId,
            },
          ],
          sends: [],
        },
      },
    ];
    const { downloadBlobFile, projectExport } = setup();

    projectExport.exportDawprojectAction();
    await flushPromises();
    await vi.waitFor(() => expect(downloadBlobFile).toHaveBeenCalledTimes(1));

    expect(confirmDialog).not.toHaveBeenCalled();
    expect(downloadBlobFile).toHaveBeenCalledTimes(1);
    const [, filename] = downloadBlobFile.mock.calls[0] as [Blob, string];
    expect(filename).toBe('Score Export.dawproject');
  });

  it('summarizes lossy DAWproject export items and cancels when declined', async () => {
    await loadProjectDocument(makeDoc('midi'));
    const store = useProjectStore();
    store.tracks[0].kind = 'audio';
    store.tracks[0].color = 'var(--track-accent)';
    store.tracks[0].pan = 0.25;
    store.clips[0].kind = 'audio';
    delete store.clips[0].assetId;
    store.clips[0].gain = 0.5;
    store.clips[0].takes = [{ assetId: 'take-2', name: 'Take 2' }];
    store.clips[0].compSegments = [{ startPpq: 0, takeIndex: 0, crossfadePpq: 0.02 }];
    store.clips[0].warp = { enabled: true, sourceBpm: 96 };
    store.tracks[0].instrument = { kind: 'synth-preset', preset: 'bright-piano' };
    store.tracks[0].midiFx = { ...DEFAULT_MIDI_FX_CONFIG, transposeSemitones: 12 };
    store.projectExternalMidi = {
      kind: 'external-midi',
      outputPortId: 'midi-out-1',
      channel: 0,
    };
    store.tracks[0].externalMidiMode = 'project';
    store.sections = [{ name: 'Chorus', color: '#123456', startPpq: 4, endPpq: 8 }];
    store.chords = [{ startPpq: 0, endPpq: 4, rootPc: 0, quality: 0 }];
    store.displayTransposeSemitones = 12;
    store.midiCcBindings.set('gain:master', { channel: 0, controller: 7 });
    store.scoreAnnotations = {
      [store.clips[0].id]: {
        [store.notes[0].id]: { dynamics: 'f' },
      },
    };
    store.mixer.soloMode = 'pfl';
    store.mixer.masteringChain = {
      preset: 'streaming-balanced',
      presetOverrides: { 'loudness.targetLufs': -14 },
      processors: [
        {
          processor: 'dynamics.limiter',
          params: { ceilingDb: -1 },
          enabled: true,
        },
      ],
    };
    store.tracks[0].frozen = { assetId: 'frozen-render-1' };
    store.tracks[0].recordInputChannel = 1;
    store.tracks[0].soloSafe = true;
    store.tracks[0].mixer = {
      gainDb: 0,
      pan: 0,
      inputTrimDb: 3,
      width: 1.4,
      polarityInvertLeft: true,
      channelDelaySamples: 12,
      panLaw: 'const6dB',
      panMode: 'dualPan',
      dualPan: { left: -0.2, right: 0.3 },
      eq: {
        enabled: true,
        bands: [{ type: 'Peak', frequencyHz: 1000, gainDb: 3, q: 1 }],
      },
      inserts: [
        {
          processor: 'dynamics.compressor',
          params: { autoMakeup: true },
          enabled: true,
          sidechainSourceTrackId: store.tracks[0].id,
        },
      ],
      sends: [],
    };
    store.automationLanes = [
      {
        target: store.tracks[0].id,
        param: 'insert:0:autoMakeup',
        points: [{ ppq: 0, value: 1 }],
        enabled: true,
      },
      {
        target: store.tracks[0].id,
        param: 'instrument:cutoffHz',
        points: [{ ppq: 0, value: 0.5 }],
        enabled: true,
      },
    ];
    saveMixerSnapshot('A');
    vi.mocked(confirmDialog).mockResolvedValueOnce(false);
    const { downloadBlobFile, projectExport } = setup();

    projectExport.exportDawprojectAction();
    await flushPromises();

    expect(confirmDialog).toHaveBeenCalledTimes(1);
    const prompt = vi.mocked(confirmDialog).mock.calls[0][0];
    expect(prompt.message).toContain('audio clip warp');
    expect(prompt.message).toContain('per-clip gain');
    expect(prompt.message).toContain('audio clip media reference');
    expect(prompt.message).toContain('alternate audio take');
    expect(prompt.message).toContain('audio comp segment');
    expect(prompt.message).toContain('track instrument');
    expect(prompt.message).toContain('MIDI FX');
    expect(prompt.message).toContain('non-hex track color');
    expect(prompt.message).toContain('legacy track pan');
    expect(prompt.message).toContain('external MIDI route');
    expect(prompt.message).toContain('arrangement section');
    expect(prompt.message).toContain('chord track symbol');
    expect(prompt.message).toContain('score display setting');
    expect(prompt.message).toContain('MIDI learn CC binding');
    expect(prompt.message).toContain('mixer snapshot slot');
    expect(prompt.message).toContain('mixer solo audition mode');
    expect(prompt.message).toContain('mastering chain');
    expect(prompt.message).toContain('score annotation');
    expect(prompt.message).toContain('frozen track render reference');
    expect(prompt.message).toContain('recording input channel');
    expect(prompt.message).toContain('solo-safe track');
    expect(prompt.message).toContain('automation lane');
    expect(prompt.message).toContain('channel strip EQ');
    expect(prompt.message).toContain('advanced channel strip DSP');
    expect(prompt.message).not.toContain('insert sidechain key');
    expect(downloadBlobFile).not.toHaveBeenCalled();
  });

  it('continues DAWproject export after acknowledging lossy items', async () => {
    await loadProjectDocument(makeDoc('midi'));
    const store = useProjectStore();
    store.tracks[0].instrument = { kind: 'synth-preset', preset: 'bright-piano' };
    vi.mocked(confirmDialog).mockResolvedValueOnce(true);
    const { downloadBlobFile, projectExport } = setup();

    projectExport.exportDawprojectAction();
    await flushPromises();
    await vi.waitFor(() => expect(downloadBlobFile).toHaveBeenCalledTimes(1));

    expect(confirmDialog).toHaveBeenCalledTimes(1);
    expect(downloadBlobFile).toHaveBeenCalledTimes(1);
    const [, filename] = downloadBlobFile.mock.calls[0] as [Blob, string];
    expect(filename).toBe('Score Export.dawproject');
  });
});

import { flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { useAppSettings } from '@/composables/useAppSettings';
import { confirmDialog } from '@/composables/useDialogs';
import { useProjectExport } from '@/composables/useProjectExport';
import { extractMusicXmlFromMxl } from '@/notation/musicxml-mxl';
import { createBrowserBackupWithReport } from '@/persistence/backup';
import { gatherProjectBundleWithReport } from '@/persistence/bundle';
import { downloadBrowserBackup, downloadSzd } from '@/persistence/local-file';
import { saveMixerSnapshot } from '@/project/command/mixer-snapshots';
import {
  addTrack,
  setAutomationLanePoints,
  setClipCcLane,
  setTrackMidiFx,
  setTrackMute,
} from '@/project/commands';
import { DEFAULT_MIDI_FX_CONFIG } from '@/project/midi-fx';
import {
  loadProjectDocument,
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  type ProjectDocument,
} from '@/project/serialization';
import { useProjectStore } from '@/project/store';
import { MESSAGES } from '@/ui/i18n';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

vi.mock('@/composables/useDialogs', () => ({
  confirmDialog: vi.fn(),
}));

vi.mock('@/persistence/backup', () => ({
  createBrowserBackupWithReport: vi.fn(),
}));

vi.mock('@/persistence/bundle', () => ({
  gatherProjectBundleWithReport: vi.fn(),
}));

vi.mock('@/persistence/local-file', () => ({
  downloadBrowserBackup: vi.fn(),
  downloadSzd: vi.fn(),
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

function setup(loop = { enabled: false, startPpq: 0, endPpq: 0 }) {
  const downloadBlobFile = vi.fn();
  const closeProjectMenu = vi.fn();
  const confirmLossAction = vi.fn(
    (message: string, opts?: { danger?: boolean; confirmLabel?: string; title?: string }) =>
      confirmDialog({
        title: opts?.title,
        message,
        danger: opts?.danger ?? false,
        confirmLabel: opts?.confirmLabel ?? 'Continue',
      }),
  );
  const projectExport = useProjectExport({
    closeProjectMenu,
    confirmLossAction,
    downloadBlobFile,
    opfsAvailable: true,
    loopEnabled: ref(loop.enabled),
    loopStartPpq: ref(loop.startPpq),
    loopEndPpq: ref(loop.endPpq),
    runAction: async (action) => {
      await action();
    },
  });
  return { closeProjectMenu, confirmLossAction, downloadBlobFile, projectExport };
}

describe('useProjectExport', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    useProjectStore().dispose();
    vi.mocked(confirmDialog).mockReset();
    vi.mocked(downloadSzd).mockReset();
    vi.mocked(downloadBrowserBackup).mockReset();
    vi.mocked(gatherProjectBundleWithReport).mockReset();
    vi.mocked(gatherProjectBundleWithReport).mockResolvedValue({
      bundle: { assets: [], fonts: [] },
      report: { complete: true, issues: [] },
    });
    vi.mocked(createBrowserBackupWithReport).mockReset();
    vi.mocked(createBrowserBackupWithReport).mockResolvedValue({
      bytes: new Uint8Array([1, 2, 3]),
      completeness: { complete: true, issues: [] },
    });
  });

  it('reports an unavailable MusicXML export as the localized reason without a raw code', async () => {
    const settings = useAppSettings();
    const previous = settings.settings.language;
    settings.set('language', 'ja');
    try {
      const errors: string[] = [];
      const projectExport = useProjectExport({
        closeProjectMenu: vi.fn(),
        confirmLossAction: vi.fn(async () => true),
        downloadBlobFile: vi.fn(),
        loopEnabled: ref(false),
        loopStartPpq: ref(0),
        loopEndPpq: ref(0),
        opfsAvailable: true,
        runAction: async (action) => {
          try {
            await action();
          } catch (err) {
            errors.push((err as Error).message);
          }
        },
      });
      const availability = projectExport.exportMusicXmlAction();
      await flushPromises();
      expect(availability.available).toBe(false);
      expect(errors).toEqual([
        MESSAGES.ja.notices.musicXmlUnavailable[availability.reason ?? 'unknown'],
      ]);
      expect(errors[0]).not.toMatch(/required|unavailable/);
    } finally {
      settings.set('language', previous);
    }
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

  it('exports the active MIDI clip as a compressed .mxl through the same path', async () => {
    await loadProjectDocument(makeDoc('midi'));
    const { closeProjectMenu, downloadBlobFile, projectExport } = setup();

    const availability = projectExport.exportMxlAction();
    await flushPromises();

    expect(availability).toEqual(projectExport.musicXmlAvailability.value);
    expect(closeProjectMenu).toHaveBeenCalledTimes(1);
    expect(downloadBlobFile).toHaveBeenCalledTimes(1);
    const [blob, filename] = downloadBlobFile.mock.calls[0] as [Blob, string];
    expect(filename).toBe('Score Export.mxl');
    expect(blob.type).toBe('application/vnd.recordare.musicxml');
    const xml = extractMusicXmlFromMxl(new Uint8Array(await blob.arrayBuffer()));
    expect(xml).toContain('<score-partwise version="4.0">');
  });

  it('does not export .mxl when the active clip is audio', async () => {
    await loadProjectDocument(makeDoc('audio'));
    const { downloadBlobFile, projectExport } = setup();

    const availability = projectExport.exportMxlAction();
    await flushPromises();

    expect(availability).toMatchObject({ available: false, reason: 'active-midi-clip-required' });
    expect(downloadBlobFile).not.toHaveBeenCalled();
  });

  it('uses the same key-aware score artifact settings as the score panel', async () => {
    await loadProjectDocument(makeDoc('midi'));
    const store = useProjectStore();
    store.scaleHighlight = { enabled: true, rootPc: 5, modeMask: 0b101010110101 }; // F major
    store.scoreDisplaySettings = {
      ...store.scoreDisplaySettings,
      displayQuantizeKey: '8',
      chordsEnabled: true,
    };
    store.sections = [{ id: 1, name: 'Verse', startPpq: 0, endPpq: 4, color: '#000000' }];
    store.markers = [{ id: 1, name: 'Intro', ppq: 0 }];
    const { downloadBlobFile, projectExport } = setup();

    projectExport.exportMusicXmlAction();
    await vi.waitFor(() => expect(downloadBlobFile).toHaveBeenCalledTimes(1));

    const [blob] = downloadBlobFile.mock.calls[0] as [Blob, string];
    const xml = await blob.text();
    expect(xml).toContain('<fifths>-1</fifths>');
    expect(xml).toContain('<rehearsal default-y="40">Verse</rehearsal>');
    expect(xml).toContain('<words default-y="24">Intro</words>');
  });

  it('does not turn the transport loop into MusicXML repeat barlines', async () => {
    await loadProjectDocument(makeDoc('midi'));
    const { downloadBlobFile, projectExport } = setup({ enabled: true, startPpq: 0, endPpq: 4 });

    projectExport.exportMusicXmlAction();
    await vi.waitFor(() => expect(downloadBlobFile).toHaveBeenCalledTimes(1));

    const [blob] = downloadBlobFile.mock.calls[0] as [Blob, string];
    await expect(blob.text()).resolves.not.toContain('<repeat ');
  });

  it('does not export MusicXML when the active clip is audio', async () => {
    await loadProjectDocument(makeDoc('audio'));
    const { downloadBlobFile, projectExport } = setup();

    const availability = projectExport.exportMusicXmlAction();
    await flushPromises();

    expect(availability).toEqual(projectExport.musicXmlAvailability.value);
    expect(availability).toMatchObject({
      available: false,
      mode: 'part',
      reason: 'active-midi-clip-required',
    });
    expect(downloadBlobFile).not.toHaveBeenCalled();
  });

  it('allows Full Score export when the active clip is audio but a MIDI track exists', async () => {
    await loadProjectDocument(makeDoc('audio'));
    const store = useProjectStore();
    const midiTrackId = addTrack({ name: 'MIDI source', kind: 'midi' });
    store.scoreDisplaySettings = { ...store.scoreDisplaySettings, fullScoreEnabled: true };
    vi.mocked(confirmDialog).mockResolvedValueOnce(true);
    const { downloadBlobFile, projectExport } = setup();

    const availability = projectExport.exportMusicXmlAction();
    await flushPromises();

    expect(availability).toEqual({ available: true, mode: 'full-score', reason: null });
    expect(store.tracks.some((track) => track.id === midiTrackId && track.kind === 'midi')).toBe(
      true,
    );
    // The score cannot carry the audio track, so the export lists it first.
    expect(vi.mocked(confirmDialog).mock.calls[0][0].message).toContain(
      '1 audio or group track(s) with clips (Keys)',
    );
    expect(downloadBlobFile).toHaveBeenCalledTimes(1);
  });

  it('shares the Full Score blocker reason between availability and the action', async () => {
    await loadProjectDocument(makeDoc('audio'));
    const store = useProjectStore();
    store.scoreDisplaySettings = { ...store.scoreDisplaySettings, fullScoreEnabled: true };
    const { downloadBlobFile, projectExport } = setup();

    const availability = projectExport.exportMusicXmlAction();
    await flushPromises();

    expect(availability).toEqual(projectExport.musicXmlAvailability.value);
    expect(availability).toMatchObject({
      available: false,
      mode: 'full-score',
      reason: 'midi-track-required',
    });
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

  it('blocks a DAWproject download when referenced audio cannot be embedded and loss is declined', async () => {
    await loadProjectDocument(makeDoc('audio'));
    vi.mocked(confirmDialog).mockResolvedValue(false);
    const { downloadBlobFile, projectExport } = setup();

    projectExport.exportDawprojectAction();
    await vi.waitFor(() => expect(confirmDialog).toHaveBeenCalledTimes(1));

    expect(vi.mocked(confirmDialog).mock.calls[0][0].message).toContain('asset-1');
    expect(downloadBlobFile).not.toHaveBeenCalled();
  });

  it('downloads the explicitly accepted incomplete DAWproject', async () => {
    await loadProjectDocument(makeDoc('audio'));
    vi.mocked(confirmDialog).mockResolvedValue(true);
    const { downloadBlobFile, projectExport } = setup();

    projectExport.exportDawprojectAction();
    await vi.waitFor(() => expect(downloadBlobFile).toHaveBeenCalledTimes(1));

    expect(confirmDialog).toHaveBeenCalledTimes(1);
    expect(downloadBlobFile).toHaveBeenCalledTimes(1);
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
    store.clips[0].warp = { enabled: false, sourceBpm: 96 };
    store.tracks[0].instrument = { kind: 'synth-preset', preset: 'acousticPiano' };
    store.tracks[0].midiFx = { ...DEFAULT_MIDI_FX_CONFIG, transposeSemitones: 12 };
    store.projectExternalMidi = {
      kind: 'external-midi',
      outputPortId: 'midi-out-1',
      channel: 0,
    };
    store.tracks[0].externalMidiMode = 'project';
    store.sections = [{ id: 2, name: 'Chorus', color: '#123456', startPpq: 4, endPpq: 8 }];
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
      preset: 'streaming',
      presetOverrides: { loudness: { targetLufs: -14 } },
      processors: [
        {
          processor: 'dynamics.limiter',
          params: { thresholdDb: -1 },
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
      panLaw: 'const6Db',
      panMode: 'dualPan',
      dualPan: { left: -0.2, right: 0.3 },
      eq: {
        enabled: true,
        bands: [{ type: 'peak', frequencyHz: 1000, gainDb: 3, q: 1 }],
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
    expect(prompt.message).toContain('disabled audio clip warp');
    expect(prompt.message).toContain('per-clip gain');
    expect(prompt.message).toContain('audio clip media reference');
    expect(prompt.message).toContain('alternate audio take');
    expect(prompt.message).toContain('audio comp segment');
    expect(prompt.message).toContain('track instrument');
    expect(prompt.message).toContain('MIDI FX');
    expect(prompt.message).toContain('non-hex track color');
    expect(prompt.message).not.toContain('legacy track pan');
    expect(prompt.message).toContain('external MIDI route');
    // Sections round-trip through the Sonare sidecar and are not listed as omitted.
    expect(prompt.message).not.toContain('arrangement section');
    expect(prompt.message).toContain('section starts as markers');
    expect(prompt.message).not.toContain('chord track symbol');
    expect(prompt.message).toContain('score display setting');
    expect(prompt.message).toContain('MIDI learn CC binding');
    expect(prompt.message).toContain('mixer snapshot slot');
    expect(prompt.message).toContain('mixer solo audition mode');
    expect(prompt.message).toContain('mastering chain');
    expect(prompt.message).toContain('score annotation');
    expect(prompt.message).toContain('frozen track render reference');
    expect(prompt.message).toContain('recording input channel');
    expect(prompt.message).toContain('solo-safe track');
    expect(prompt.message).not.toContain('automation lane');
    expect(prompt.message).toContain('channel strip EQ');
    expect(prompt.message).toContain('advanced channel strip DSP');
    expect(prompt.message).not.toContain('insert sidechain key');
    expect(downloadBlobFile).not.toHaveBeenCalled();
  });

  it('asks before a MusicXML export that moves off-grid notes and drops expression', async () => {
    const doc = makeDoc('midi');
    doc.tracks[0].clips[0].notes = [
      { pitch: 60, velocity: 100, startPpq: 0.1, durationPpq: 1, channel: 0 },
    ];
    doc.tracks[0].clips[0].ccLanes = [
      { controller: 1, channel: 0, points: [{ ppq: 0, value: 64 }] },
    ];
    await loadProjectDocument(doc);
    vi.mocked(confirmDialog).mockResolvedValueOnce(false);
    const { downloadBlobFile, projectExport } = setup();

    projectExport.exportMusicXmlAction();
    await flushPromises();

    expect(confirmDialog).toHaveBeenCalledTimes(1);
    const prompt = vi.mocked(confirmDialog).mock.calls[0][0];
    expect(prompt.title).toBe('MusicXML export limitations');
    expect(prompt.message).toContain('1 note position(s) or length(s) moved to the display grid');
    expect(prompt.message).toContain('1 MIDI expression lane(s)');
    expect(downloadBlobFile).not.toHaveBeenCalled();
  });

  it('continues DAWproject export after acknowledging lossy items', async () => {
    await loadProjectDocument(makeDoc('midi'));
    const store = useProjectStore();
    store.tracks[0].instrument = { kind: 'synth-preset', preset: 'acousticPiano' };
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

  it('blocks incomplete portable exports until the user explicitly accepts the loss', async () => {
    await useProjectStore().init();
    const issue = {
      kind: 'audio-asset' as const,
      mediaId: 'missing-audio',
      role: 'clip' as const,
      reason: 'missing' as const,
      trackId: 1,
      clipId: 2,
    };
    vi.mocked(gatherProjectBundleWithReport).mockResolvedValue({
      bundle: { assets: [], fonts: [] },
      report: { complete: false, issues: [issue] },
    });
    vi.mocked(createBrowserBackupWithReport).mockResolvedValue({
      bytes: new Uint8Array([1, 2, 3]),
      completeness: { complete: false, issues: [issue] },
    });
    const { confirmLossAction, projectExport } = setup();
    confirmLossAction.mockResolvedValue(false);

    projectExport.exportSzdAction();
    await flushPromises();
    projectExport.exportBrowserBackupAction();
    await flushPromises();

    expect(confirmLossAction).toHaveBeenCalledTimes(2);
    expect(confirmLossAction.mock.calls[0][0]).toContain('missing-audio');
    expect(downloadSzd).not.toHaveBeenCalled();
    expect(downloadBrowserBackup).not.toHaveBeenCalled();
  });

  it('requires loss consent before exporting a MIDI 2.0 clip that omits expression data', async () => {
    const store = useProjectStore();
    await store.init();
    setClipCcLane(store.clipId, 1, 0, [{ ppq: 0, value: 64 }]);
    const { confirmLossAction, downloadBlobFile, projectExport } = setup();
    confirmLossAction.mockResolvedValue(false);

    projectExport.exportMidi2Action();
    await flushPromises();

    expect(confirmLossAction).toHaveBeenCalledWith(
      expect.stringContaining('expression'),
      expect.objectContaining({ confirmLabel: expect.any(String) }),
    );
    expect(downloadBlobFile).not.toHaveBeenCalled();
  });

  it('lists every SMF loss before writing the file', async () => {
    const store = useProjectStore();
    await store.init();
    const trackId = store.tracks[0].id;
    setTrackMidiFx(trackId, { ...DEFAULT_MIDI_FX_CONFIG, transposeSemitones: 12 });
    setAutomationLanePoints(trackId, 'pan', [{ ppq: 0, value: 0.5, curve: 'linear' }]);
    setTrackMute(trackId, true);
    const { confirmLossAction, downloadBlobFile, projectExport } = setup();
    confirmLossAction.mockResolvedValue(false);

    projectExport.exportSmfAction();
    await flushPromises();

    expect(confirmLossAction).toHaveBeenCalledWith(
      expect.stringMatching(/1 track mute.+1 MIDI FX transform.+1 automation lane/s),
      expect.objectContaining({ title: 'SMF export limitations' }),
    );
    expect(downloadBlobFile).not.toHaveBeenCalled();
  });

  it('downloads a complete .szd export under the project name', async () => {
    await useProjectStore().init();
    const { confirmLossAction, projectExport } = setup();

    projectExport.exportSzdAction();
    await vi.waitFor(() => expect(downloadSzd).toHaveBeenCalledTimes(1));

    const [name, bytes] = vi.mocked(downloadSzd).mock.calls[0];
    expect(name).toBe(useProjectStore().projectName);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBeGreaterThan(0);
    expect(confirmLossAction).not.toHaveBeenCalled();
  });

  it('downloads a complete browser backup under the app name', async () => {
    await useProjectStore().init();
    const { confirmLossAction, projectExport } = setup();

    projectExport.exportBrowserBackupAction();
    await vi.waitFor(() => expect(downloadBrowserBackup).toHaveBeenCalledTimes(1));

    expect(downloadBrowserBackup).toHaveBeenCalledWith('sonare-studio', new Uint8Array([1, 2, 3]));
    expect(confirmLossAction).not.toHaveBeenCalled();
  });
});

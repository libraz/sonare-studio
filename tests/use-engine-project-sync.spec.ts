import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick, ref, shallowRef } from 'vue';
import { useEngineProjectSync } from '@/composables/useEngineProjectSync';
import type { MidiSync } from '@/engine/midi-sync';
import type { MixerSync } from '@/engine/mixer-sync';
import type { StripSync } from '@/engine/strip-sync';
import type { WebMidiOutputBridge } from '@/engine/web-midi-output';
import { instrumentAutomationParam } from '@/project/automation';
import {
  setProjectExternalMidiDefault,
  setTrackExternalMidiMode,
  setTrackMidiFx,
} from '@/project/commands';
import { sanitizeMidiFxConfig } from '@/project/midi-fx';
import { type ScheduledProjectClip, scheduleProjectClips } from '@/project/scheduling';
import { useProjectStore } from '@/project/store';
import type { EditorClip, EditorTrack } from '@/project/types';
import { resetAutomationStripModes, setAutomationStripMode } from '@/ui/mixer/automation-mode';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  return { ensureWasm: async () => createFakeWasmModule() };
});

vi.mock('@/project/scheduling', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/project/scheduling')>();
  return {
    ...actual,
    scheduleProjectClips: vi.fn(actual.scheduleProjectClips),
  };
});

function track(id: number): EditorTrack {
  return {
    id,
    name: `Track ${id}`,
    color: '#60a5fa',
    kind: 'midi',
    mute: false,
    solo: false,
    volume: 1,
    pan: 0,
    order: id,
    instrument: { kind: 'synth-preset', preset: 'acoustic-piano' },
  };
}

function clip(trackId: number): EditorClip {
  return {
    id: trackId,
    trackId,
    name: `Clip ${trackId}`,
    startPpq: 0,
    lengthPpq: 1,
    sourceOffsetPpq: 0,
    gain: 1,
    loopEnabled: false,
    loopLengthPpq: 0,
    notes: [{ id: 1, pitch: 60, velocity: 100, startPpq: 0, durationPpq: 1, channel: 0 }],
  };
}

describe('useEngineProjectSync', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    resetAutomationStripModes();
    vi.mocked(scheduleProjectClips).mockReset();
  });

  it('declares mixer lanes before MIDI instrument binding', async () => {
    const store = useProjectStore();
    store.dispose();
    await store.init();
    store.tracks = [track(1)];
    store.clips = [clip(1)];

    const calls: string[] = [];
    const mixerSync: MixerSync = {
      sync: vi.fn(() => calls.push('mixer')),
      laneTrackIds: () => [1],
    };
    const stripSync = { sync: vi.fn(() => calls.push('strip')) } as unknown as StripSync;
    const midiSync: MidiSync = {
      sync: vi.fn(async () => {
        calls.push('midi');
      }),
      scheduledClipCount: () => 1,
    };

    const scope = effectScope();
    const projectSync = scope.run(() =>
      useEngineProjectSync({
        bridge: shallowRef(null),
        scope: shallowRef(null),
        errorMessage: ref(''),
        handle: shallowRef(null),
        transport: { setTempoMap: vi.fn(), setTempo: vi.fn() } as never,
      }),
    );
    if (!projectSync) throw new Error('effect scope did not run');

    projectSync.setEngineSyncHandles({
      mixerSync,
      stripSync,
      automationSync: null,
      midiSync,
      transportSync: null,
      webMidiOutput: null,
    });

    await projectSync.syncMidiState();

    expect(calls).toEqual(['mixer', 'strip', 'midi']);
    scope.stop();
  });

  it('reports no meter/scope source for lanes past the meter target range', () => {
    const laneTrackIds = Array.from({ length: 33 }, (_, i) => i + 1);
    const mixerSync: MixerSync = { sync: vi.fn(), laneTrackIds: () => laneTrackIds };
    const stripSync = { sync: vi.fn() } as unknown as StripSync;
    const bridge = { forTarget: (id: number) => ({ id }) } as never;
    const scopeBridge = { forTarget: (id: number) => ({ id }) } as never;

    const scope = effectScope();
    const projectSync = scope.run(() =>
      useEngineProjectSync({
        bridge: shallowRef(bridge),
        scope: shallowRef(scopeBridge),
        errorMessage: ref(''),
        handle: shallowRef(null),
        transport: { setTempoMap: vi.fn(), setTempo: vi.fn() } as never,
      }),
    );
    if (!projectSync) throw new Error('effect scope did not run');
    projectSync.setEngineSyncHandles({
      mixerSync,
      stripSync,
      automationSync: null,
      midiSync: { sync: vi.fn(async () => {}), scheduledClipCount: () => 0 },
      transportSync: null,
      webMidiOutput: null,
    });

    // Lane 0 (track id 1) resolves to meter target 1.
    expect(projectSync.trackMeterSource(1)).toEqual({ id: 1 });
    expect(projectSync.trackScopeSource(1)).toEqual({ id: 1 });
    // Lane 32 (track id 33) would alias to target 33 — the first bus id — so it
    // must resolve to no source instead.
    expect(projectSync.trackMeterSource(33)).toBeNull();
    expect(projectSync.trackScopeSource(33)).toBeNull();
    scope.stop();
  });

  it('publishes the MIDI sync SoundFont report through the persistent media warning', async () => {
    const store = useProjectStore();
    store.dispose();
    await store.init();
    store.projectName = 'SF2 Project';
    store.tracks = [
      {
        ...track(7),
        instrument: { kind: 'sf2', fontId: 'missing-font' },
      },
    ];
    const mixerSync: MixerSync = { sync: vi.fn(), laneTrackIds: () => [7] };
    const stripSync = { sync: vi.fn() } as unknown as StripSync;
    const midiSync: MidiSync = {
      sync: vi.fn(async () => undefined),
      scheduledClipCount: () => 0,
      mediaIssues: () => [
        {
          kind: 'soundfont',
          mediaId: 'missing-font',
          role: 'instrument',
          reason: 'unreadable',
          trackId: 7,
        },
      ],
    };
    const mediaWarning = ref('');
    const scope = effectScope();
    const projectSync = scope.run(() =>
      useEngineProjectSync({
        bridge: shallowRef(null),
        scope: shallowRef(null),
        errorMessage: ref(''),
        mediaWarning,
        handle: shallowRef(null),
        transport: { setTempoMap: vi.fn(), setTempo: vi.fn() } as never,
      }),
    );
    if (!projectSync) throw new Error('effect scope did not run');
    projectSync.setEngineSyncHandles({
      mixerSync,
      stripSync,
      automationSync: null,
      midiSync,
      transportSync: null,
      webMidiOutput: null,
    });

    await projectSync.syncMidiState();

    expect(projectSync.mediaReport.value.issues[0]).toMatchObject({
      projectName: 'SF2 Project',
      mediaId: 'missing-font',
      trackId: 7,
    });
    expect(mediaWarning.value).toContain('missing-font');
    expect(mediaWarning.value).toContain('Open Media to relink');
    scope.stop();
  });

  it('resyncs MIDI routing when External MIDI mode, shared route, or MIDI-FX changes', async () => {
    const store = useProjectStore();
    store.dispose();
    await store.init();
    store.tracks = [track(1)];
    store.clips = [clip(1)];

    const mixerSync: MixerSync = {
      sync: vi.fn(),
      laneTrackIds: () => [1],
    };
    const stripSync = { sync: vi.fn() } as unknown as StripSync;
    const midiSync: MidiSync = {
      sync: vi.fn(async () => undefined),
      scheduledClipCount: () => 1,
    };
    const webMidiOutput: WebMidiOutputBridge = {
      available: vi.fn(() => true),
      outputs: vi.fn(() => []),
      setRoutes: vi.fn(),
      syncRoutes: vi.fn(),
      start: vi.fn(async () => true),
      dispose: vi.fn(),
    };

    const scope = effectScope();
    const projectSync = scope.run(() =>
      useEngineProjectSync({
        bridge: shallowRef(null),
        scope: shallowRef(null),
        errorMessage: ref(''),
        handle: shallowRef(null),
        transport: { setTempoMap: vi.fn(), setTempo: vi.fn() } as never,
      }),
    );
    if (!projectSync) throw new Error('effect scope did not run');

    projectSync.setEngineSyncHandles({
      mixerSync,
      stripSync,
      automationSync: null,
      midiSync,
      transportSync: null,
      webMidiOutput,
    });
    await projectSync.syncMidiState();
    expect(midiSync.sync).toHaveBeenCalledTimes(1);
    await nextTick();
    vi.mocked(midiSync.sync).mockClear();
    vi.mocked(webMidiOutput.syncRoutes).mockClear();

    setProjectExternalMidiDefault({ kind: 'external-midi', outputPortId: 'out-1', channel: 2 });
    await nextTick();
    await vi.waitFor(() => expect(midiSync.sync).toHaveBeenCalledTimes(1));
    expect(webMidiOutput.syncRoutes).toHaveBeenLastCalledWith(
      store.tracks,
      store.projectExternalMidi,
    );

    vi.mocked(midiSync.sync).mockClear();
    setTrackExternalMidiMode(store.tracks[0].id, 'project');
    await nextTick();
    await vi.waitFor(() => expect(midiSync.sync).toHaveBeenCalledTimes(1));

    vi.mocked(midiSync.sync).mockClear();
    setTrackMidiFx(store.tracks[0].id, sanitizeMidiFxConfig({ transposeSemitones: 12 }));
    await nextTick();
    await vi.waitFor(() => expect(midiSync.sync).toHaveBeenCalled());
    scope.stop();
  });

  it('debounces consecutive MIDI content edits into one engine sync', async () => {
    vi.useFakeTimers();
    const store = useProjectStore();
    store.dispose();
    await store.init();
    store.tracks = [track(1)];
    store.clips = [clip(1)];
    const midiSync: MidiSync = { sync: vi.fn(async () => undefined), scheduledClipCount: () => 1 };
    const scope = effectScope();
    const projectSync = scope.run(() =>
      useEngineProjectSync({
        bridge: shallowRef(null),
        scope: shallowRef(null),
        errorMessage: ref(''),
        handle: shallowRef(null),
        transport: { setTempoMap: vi.fn(), setTempo: vi.fn() } as never,
      }),
    );
    if (!projectSync) throw new Error('effect scope did not run');
    projectSync.setEngineSyncHandles({
      mixerSync: { sync: vi.fn(), laneTrackIds: () => [1] },
      stripSync: { sync: vi.fn() } as unknown as StripSync,
      automationSync: null,
      midiSync,
      transportSync: null,
      webMidiOutput: null,
    });
    await projectSync.syncMidiState();
    vi.mocked(midiSync.sync).mockClear();

    store.clips = store.clips.map((item) =>
      item.id === 1 ? { ...item, notes: [{ ...item.notes[0], pitch: 61 }] } : item,
    );
    await nextTick();
    await vi.advanceTimersByTimeAsync(99);
    expect(midiSync.sync).not.toHaveBeenCalled();

    store.clips = store.clips.map((item) =>
      item.id === 1 ? { ...item, notes: [{ ...item.notes[0], pitch: 62 }] } : item,
    );
    await nextTick();
    await vi.advanceTimersByTimeAsync(100);
    expect(midiSync.sync).toHaveBeenCalledTimes(1);
    scope.stop();
    vi.useRealTimers();
  });

  it('passes instrument automation lanes and the current PPQ to MIDI sync', async () => {
    const store = useProjectStore();
    store.dispose();
    await store.init();
    store.tracks = [track(1)];
    store.clips = [clip(1)];
    store.automationLanes = [
      {
        target: 1,
        param: instrumentAutomationParam('cutoffHz'),
        enabled: true,
        points: [{ ppq: 0, value: 900 }],
      },
    ];

    const midiSync: MidiSync = {
      sync: vi.fn(async () => undefined),
      scheduledClipCount: () => 1,
    };
    const transport = {
      positionPpq: ref(3),
      setTempoMap: vi.fn(),
      setTempo: vi.fn(),
    };
    const scope = effectScope();
    const projectSync = scope.run(() =>
      useEngineProjectSync({
        bridge: shallowRef(null),
        scope: shallowRef(null),
        errorMessage: ref(''),
        handle: shallowRef(null),
        transport: transport as never,
      }),
    );
    if (!projectSync) throw new Error('effect scope did not run');

    projectSync.setEngineSyncHandles({
      mixerSync: null,
      stripSync: null,
      automationSync: null,
      midiSync,
      transportSync: null,
      webMidiOutput: null,
    });

    await projectSync.syncMidiState();

    expect(midiSync.sync).toHaveBeenLastCalledWith(
      store.tracks,
      store.clips,
      [{ startPpq: 0, bpm: store.tempoBpm }],
      store.projectExternalMidi,
      store.automationLanes,
      3,
    );

    vi.mocked(midiSync.sync).mockClear();
    transport.positionPpq.value = 4;
    await nextTick();
    expect(midiSync.sync).not.toHaveBeenCalled();
    transport.positionPpq.value = 5;
    await nextTick();
    await vi.waitFor(() => expect(midiSync.sync).toHaveBeenCalledTimes(1));
    expect(midiSync.sync).toHaveBeenLastCalledWith(
      store.tracks,
      store.clips,
      [{ startPpq: 0, bpm: store.tempoBpm }],
      store.projectExternalMidi,
      store.automationLanes,
      5,
    );

    vi.mocked(midiSync.sync).mockClear();
    store.automationLanes = [
      {
        target: 1,
        param: instrumentAutomationParam('cutoffHz'),
        enabled: true,
        points: [{ ppq: 0, value: 1200 }],
      },
    ];
    await nextTick();
    await vi.waitFor(() => expect(midiSync.sync).toHaveBeenCalledTimes(1));
    scope.stop();
  });

  it('does not resync instrument automation on playhead moves during playback', async () => {
    const store = useProjectStore();
    store.dispose();
    await store.init();
    store.tracks = [track(1)];
    store.clips = [clip(1)];
    store.automationLanes = [
      {
        target: 1,
        param: instrumentAutomationParam('cutoffHz'),
        enabled: true,
        points: [{ ppq: 0, value: 900 }],
      },
    ];

    const midiSync: MidiSync = {
      sync: vi.fn(async () => undefined),
      scheduledClipCount: () => 1,
    };
    // Rolling transport: the engine defers instrument syncs during playback, so
    // re-evaluating per frame would only flood that deferred queue and stall the
    // main thread. The playhead watcher must stay quiet while playing.
    const transport = {
      positionPpq: ref(3),
      isPlaying: ref(true),
      setTempoMap: vi.fn(),
      setTempo: vi.fn(),
    };
    const scope = effectScope();
    const projectSync = scope.run(() =>
      useEngineProjectSync({
        bridge: shallowRef(null),
        scope: shallowRef(null),
        errorMessage: ref(''),
        handle: shallowRef(null),
        transport: transport as never,
      }),
    );
    if (!projectSync) throw new Error('effect scope did not run');

    projectSync.setEngineSyncHandles({
      mixerSync: null,
      stripSync: null,
      automationSync: null,
      midiSync,
      transportSync: null,
      webMidiOutput: null,
    });

    await projectSync.syncMidiState();
    vi.mocked(midiSync.sync).mockClear();

    transport.positionPpq.value = 4;
    await nextTick();
    expect(midiSync.sync).not.toHaveBeenCalled();

    // Once parked again, a seek re-bakes the start-position value.
    transport.isPlaying.value = false;
    transport.positionPpq.value = 5;
    await nextTick();
    await vi.waitFor(() => expect(midiSync.sync).toHaveBeenCalledTimes(1));
    expect(midiSync.sync).toHaveBeenLastCalledWith(
      store.tracks,
      store.clips,
      [{ startPpq: 0, bpm: store.tempoBpm }],
      store.projectExternalMidi,
      store.automationLanes,
      5,
    );
    scope.stop();
  });

  it('does not resync MIDI on playhead moves when no instrument automation is active', async () => {
    const store = useProjectStore();
    store.dispose();
    await store.init();
    store.tracks = [track(1)];
    store.clips = [clip(1)];
    store.automationLanes = [
      { target: 1, param: 'faderDb', enabled: true, points: [{ ppq: 0, value: -6 }] },
      {
        target: 1,
        param: instrumentAutomationParam('cutoffHz'),
        enabled: false,
        points: [{ ppq: 0, value: 900 }],
      },
    ];

    const midiSync: MidiSync = {
      sync: vi.fn(async () => undefined),
      scheduledClipCount: () => 1,
    };
    const transport = {
      positionPpq: ref(3),
      setTempoMap: vi.fn(),
      setTempo: vi.fn(),
    };
    const scope = effectScope();
    const projectSync = scope.run(() =>
      useEngineProjectSync({
        bridge: shallowRef(null),
        scope: shallowRef(null),
        errorMessage: ref(''),
        handle: shallowRef(null),
        transport: transport as never,
      }),
    );
    if (!projectSync) throw new Error('effect scope did not run');

    projectSync.setEngineSyncHandles({
      mixerSync: null,
      stripSync: null,
      automationSync: null,
      midiSync,
      transportSync: null,
      webMidiOutput: null,
    });

    await projectSync.syncMidiState();
    vi.mocked(midiSync.sync).mockClear();
    transport.positionPpq.value = 4;
    await nextTick();

    expect(midiSync.sync).not.toHaveBeenCalled();
    scope.stop();
  });

  it('keeps off-mode automation lanes out of the engine until read or write mode is enabled', async () => {
    const store = useProjectStore();
    store.dispose();
    await store.init();
    store.tracks = [track(1)];
    store.automationLanes = [
      { target: 1, param: 'faderDb', enabled: true, points: [{ ppq: 0, value: -6 }] },
    ];

    const automationSync = { sync: vi.fn() };
    const scope = effectScope();
    const projectSync = scope.run(() =>
      useEngineProjectSync({
        bridge: shallowRef(null),
        scope: shallowRef(null),
        errorMessage: ref(''),
        handle: shallowRef(null),
        transport: { setTempoMap: vi.fn(), setTempo: vi.fn() } as never,
      }),
    );
    if (!projectSync) throw new Error('effect scope did not run');

    projectSync.setEngineSyncHandles({
      mixerSync: null,
      stripSync: null,
      automationSync,
      midiSync: null,
      transportSync: null,
      webMidiOutput: null,
    });

    projectSync.syncAutomationState();
    expect(automationSync.sync).toHaveBeenLastCalledWith(store.automationLanes);

    setAutomationStripMode(1, 'touch');
    store.documentGeneration += 1;
    await nextTick();

    expect(automationSync.sync).toHaveBeenLastCalledWith(store.automationLanes);
    scope.stop();
  });

  it('surfaces mixer, automation and transport sync exceptions', async () => {
    const store = useProjectStore();
    store.dispose();
    await store.init();
    store.tracks = [track(1)];

    const errorMessage = ref('');
    const scope = effectScope();
    const projectSync = scope.run(() =>
      useEngineProjectSync({
        bridge: shallowRef(null),
        scope: shallowRef(null),
        errorMessage,
        handle: shallowRef(null),
        transport: { setTempoMap: vi.fn(), setTempo: vi.fn() } as never,
      }),
    );
    if (!projectSync) throw new Error('effect scope did not run');

    projectSync.setEngineSyncHandles({
      mixerSync: {
        sync: vi.fn(() => {
          throw new Error('mixer boom');
        }),
        laneTrackIds: () => [],
      },
      stripSync: { sync: vi.fn() } as unknown as StripSync,
      automationSync: {
        sync: vi.fn(() => {
          throw new Error('automation boom');
        }),
      },
      midiSync: null,
      transportSync: {
        sync: vi.fn(() => {
          throw new Error('transport boom');
        }),
      } as never,
      webMidiOutput: null,
    });

    projectSync.syncMixerState();
    expect(errorMessage.value).toBe('mixer boom');
    projectSync.syncAutomationState();
    expect(errorMessage.value).toBe('automation boom');
    projectSync.syncTransportState();
    expect(errorMessage.value).toBe('transport boom');
    scope.stop();
  });

  it('invalidates an in-flight audio clip apply when project sync is disposed', async () => {
    const store = useProjectStore();
    store.dispose();
    await store.init();
    const removeClip = vi.fn();
    const handle = shallowRef({
      engine: { removeClip },
    });
    let resolveSchedule!: (clips: ScheduledProjectClip[]) => void;
    vi.mocked(scheduleProjectClips).mockReturnValue(
      new Promise((resolve) => {
        resolveSchedule = resolve;
      }),
    );

    const scope = effectScope();
    const projectSync = scope.run(() =>
      useEngineProjectSync({
        bridge: shallowRef(null),
        scope: shallowRef(null),
        errorMessage: ref(''),
        handle: handle as never,
        transport: { setTempoMap: vi.fn(), setTempo: vi.fn() } as never,
      }),
    );
    if (!projectSync) throw new Error('effect scope did not run');

    projectSync.applyNow();
    expect(scheduleProjectClips).toHaveBeenCalledWith(handle.value, {
      retainedScheduleBytes: 0,
      signal: expect.any(AbortSignal),
      onMediaIssue: expect.any(Function),
    });

    projectSync.disposeEngineProjectSync();
    resolveSchedule([{ engineClipId: 99, clipId: 1, trackId: 1 }]);
    await vi.waitFor(() => expect(removeClip).toHaveBeenCalledWith(99));

    expect(projectSync.scheduledClips()).toEqual([]);
    expect(projectSync.scheduledCount.value).toBe(0);
    scope.stop();
  });

  it('publishes a persistent relink warning for skipped live audio media', async () => {
    const store = useProjectStore();
    store.dispose();
    await store.init();
    const handle = shallowRef({ engine: { removeClip: vi.fn() } });
    vi.mocked(scheduleProjectClips).mockImplementation(async (_handle, options) => {
      options.onMediaIssue?.({
        kind: 'audio-asset',
        mediaId: 'missing-live',
        role: 'take',
        reason: 'unreadable',
        trackId: 4,
        clipId: 9,
      });
      return [];
    });
    const mediaWarning = ref('');
    const scope = effectScope();
    const projectSync = scope.run(() =>
      useEngineProjectSync({
        bridge: shallowRef(null),
        scope: shallowRef(null),
        errorMessage: ref(''),
        mediaWarning,
        handle: handle as never,
        transport: { setTempoMap: vi.fn(), setTempo: vi.fn() } as never,
      }),
    );
    if (!projectSync) throw new Error('effect scope did not run');

    await projectSync.applyToEngine();

    expect(projectSync.mediaReport.value).toMatchObject({ complete: false });
    expect(mediaWarning.value).toContain('Open Media to relink');
    expect(mediaWarning.value).toContain('missing-live');
    expect(mediaWarning.value).toContain('track 4');
    expect(mediaWarning.value).toContain('clip 9');
    scope.stop();
  });

  it('invalidates preparation and reschedules when a later tempo segment changes', async () => {
    vi.useFakeTimers();
    try {
      const store = useProjectStore();
      store.dispose();
      await store.init();
      store.tracks = [{ ...track(1), kind: 'audio', instrument: undefined }];
      store.clips = [{ ...clip(1), kind: 'audio', notes: [], assetId: 'audio-1' }];
      store.tempoSegments = [
        { startPpq: 0, bpm: 120 },
        { startPpq: 4, bpm: 90 },
      ];
      const handle = shallowRef({ engine: { removeClip: vi.fn() } });
      let resolveSchedule!: (clips: ScheduledProjectClip[]) => void;
      vi.mocked(scheduleProjectClips).mockImplementation(
        (_handle, options) =>
          new Promise((resolve) => {
            expect(options?.signal).toBeInstanceOf(AbortSignal);
            resolveSchedule = resolve;
          }),
      );
      const scope = effectScope();
      const projectSync = scope.run(() =>
        useEngineProjectSync({
          bridge: shallowRef(null),
          scope: shallowRef(null),
          errorMessage: ref(''),
          handle: handle as never,
          transport: { setTempoMap: vi.fn(), setTempo: vi.fn() } as never,
        }),
      );
      if (!projectSync) throw new Error('effect scope did not run');

      projectSync.applyNow();
      const firstSignal = vi.mocked(scheduleProjectClips).mock.calls[0]?.[1]?.signal;
      expect(firstSignal?.aborted).toBe(false);
      store.tempoSegments = [
        { startPpq: 0, bpm: 120 },
        { startPpq: 4, bpm: 60 },
      ];
      await nextTick();
      expect(firstSignal?.aborted).toBe(true);
      expect(projectSync.applyPending.value).toBe(true);
      resolveSchedule([]);
      await Promise.resolve();

      await vi.advanceTimersByTimeAsync(400);
      expect(scheduleProjectClips).toHaveBeenCalledTimes(2);
      projectSync.disposeEngineProjectSync();
      scope.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('retains exact residual ownership and requests rebuild after remove failure', async () => {
    const store = useProjectStore();
    store.dispose();
    await store.init();
    const removeClip = vi.fn<(id: number) => void>();
    const handle = shallowRef({ engine: { removeClip } });
    const oldClip = { engineClipId: 10, clipId: 1, trackId: 1 };
    const rolledBackNext = { engineClipId: 20, clipId: 2, trackId: 1 };
    const retryClip = { engineClipId: 30, clipId: 3, trackId: 1 };
    vi.mocked(scheduleProjectClips)
      .mockResolvedValueOnce([oldClip])
      .mockResolvedValueOnce([rolledBackNext])
      .mockResolvedValueOnce([retryClip]);
    const errorMessage = ref('');
    const scope = effectScope();
    const projectSync = scope.run(() =>
      useEngineProjectSync({
        bridge: shallowRef(null),
        scope: shallowRef(null),
        errorMessage,
        handle: handle as never,
        transport: { setTempoMap: vi.fn(), setTempo: vi.fn() } as never,
      }),
    );
    if (!projectSync) throw new Error('effect scope did not run');
    const rebuild = vi.fn();
    projectSync.setEngineRebuildHandler(rebuild);

    await projectSync.applyToEngine();
    removeClip.mockImplementation((id) => {
      if (id === oldClip.engineClipId) throw new Error('old remove failed');
    });
    await projectSync.applyToEngine();

    expect(removeClip).toHaveBeenCalledWith(oldClip.engineClipId);
    expect(removeClip).toHaveBeenCalledWith(rolledBackNext.engineClipId);
    expect(projectSync.scheduledClips()).toEqual([oldClip]);
    expect(projectSync.scheduledCount.value).toBe(1);
    expect(projectSync.engineRebuildRequired.value).toBe(true);
    expect(rebuild).toHaveBeenCalledTimes(1);
    expect(errorMessage.value).toContain('failed to remove 1 engine clip');

    removeClip.mockImplementation(() => undefined);
    await projectSync.applyToEngine();
    expect(projectSync.scheduledClips()).toEqual([retryClip]);
    expect(projectSync.engineRebuildRequired.value).toBe(false);
    scope.stop();
  });
});

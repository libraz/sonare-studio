import { ref, type ShallowRef, watch } from 'vue';
import type { useTransport } from '@/composables/useTransport';
import type { AutomationSync } from '@/engine/automation-sync';
import type { EngineHandle } from '@/engine/engine';
import {
  busMeterTargetId,
  laneMeterTargetId,
  MASTER_METER_TARGET_ID,
  MAX_BUS_METER_TARGETS,
  MAX_LANE_METER_TARGETS,
} from '@/engine/meter-targets';
import type { MeterBridge, MeterSource } from '@/engine/meters';
import type { MidiSync } from '@/engine/midi-sync';
import type { MixerSync } from '@/engine/mixer-sync';
import type { ScopeBridge, ScopeSource } from '@/engine/scope';
import type { StripSync } from '@/engine/strip-sync';
import type { TransportSync } from '@/engine/transport-sync';
import type { WebMidiOutputBridge } from '@/engine/web-midi-output';
import { describeError } from '@/lib/errors';
import { parseInstrumentAutomationParam } from '@/project/automation';
import {
  createMediaCompletenessReport,
  formatMediaCompletenessReport,
  type MediaCompletenessIssue,
  type MediaCompletenessReport,
} from '@/project/media-completeness';
import {
  AudioScheduleReplaceError,
  cleanupScheduledProjectClips,
  replaceScheduledProjectClips,
  type ScheduledProjectClip,
  scheduleProjectClips,
} from '@/project/scheduling';
import { useProjectStore } from '@/project/store';
import { type EditorClip, type EditorTrack, isAudioClip } from '@/project/types';
import {
  automationStripModeRevision,
  isAutomationStripPlaybackEnabled,
  resetAutomationStripModes,
} from '@/ui/mixer/automation-mode';

const APPLY_DEBOUNCE_MS = 400;

type Transport = ReturnType<typeof useTransport>;

export interface EngineProjectSyncOptions {
  bridge: ShallowRef<MeterBridge | null>;
  scope: ShallowRef<ScopeBridge | null>;
  errorMessage: { value: string };
  mediaWarning?: { value: string };
  mediaWarningIntro?: { value: string };
  handle: ShallowRef<EngineHandle | null>;
  transport: Transport;
}

export interface EngineSyncHandles {
  automationSync: AutomationSync | null;
  midiSync: MidiSync | null;
  mixerSync: MixerSync | null;
  stripSync: StripSync | null;
  transportSync: TransportSync | null;
  webMidiOutput: WebMidiOutputBridge | null;
}

export interface ApplyToEngineOptions {
  /** Staged handle used during startup before the public handle is committed. */
  handle?: EngineHandle;
  /** Re-throws after recording the UI error, so startup can roll back. */
  throwOnError?: boolean;
}

export interface InitialEngineSyncOptions {
  /** Re-throws after recording the UI error, so startup can roll back. */
  throwOnError?: boolean;
}

function trackScheduleKey(track: EditorTrack): string {
  return `${track.id}|${track.kind}|${track.frozen?.assetId ?? ''}`;
}

function trackMidiSyncKey(track: EditorTrack): string {
  return [
    track.id,
    JSON.stringify(track.instrument ?? null),
    track.externalMidiMode ?? '',
    JSON.stringify(track.midiFx ?? null),
    track.frozen?.assetId ?? '',
  ].join('|');
}

function clipScheduleKey(clip: EditorClip): string {
  const { name: _name, ...rest } = clip;
  return JSON.stringify(rest);
}

function instrumentAutomationSyncKey(
  lanes: ReturnType<typeof useProjectStore>['automationLanes'],
): string {
  return JSON.stringify(
    lanes.filter(
      (lane) => typeof lane.target === 'number' && parseInstrumentAutomationParam(lane.param),
    ),
  );
}

function hasInstrumentAutomation(lanes: ReturnType<typeof useProjectStore>['automationLanes']) {
  return lanes.some(
    (lane) =>
      lane.enabled && typeof lane.target === 'number' && parseInstrumentAutomationParam(lane.param),
  );
}

export function useEngineProjectSync(options: EngineProjectSyncOptions) {
  const { bridge, scope, errorMessage, handle, transport } = options;
  const store = useProjectStore();

  let scheduledClips: ScheduledProjectClip[] = [];
  let mixerSync: MixerSync | null = null;
  let stripSync: StripSync | null = null;
  let automationSync: AutomationSync | null = null;
  let midiSync: MidiSync | null = null;
  let transportSync: TransportSync | null = null;
  let webMidiOutput: WebMidiOutputBridge | null = null;
  let applyGeneration = 0;
  let applyController: AbortController | null = null;
  let applyTimer: ReturnType<typeof setTimeout> | null = null;
  let instrumentScrubTimer: ReturnType<typeof setTimeout> | null = null;
  let engineRebuildHandler: (() => void | Promise<void>) | null = null;
  let midiSyncQueue: Promise<void> = Promise.resolve();
  let audioMediaIssues: MediaCompletenessIssue[] = [];
  let midiMediaIssues: MediaCompletenessIssue[] = [];

  const scheduledCount = ref(0);
  const applyPending = ref(false);
  const engineRebuildRequired = ref(false);
  const mediaReport = ref<MediaCompletenessReport>(createMediaCompletenessReport());

  /** Collapses parked pointer scrubs to one instrument-automation re-bake. */
  const INSTRUMENT_SCRUB_DEBOUNCE_MS = 100;

  function publishMediaReport(): void {
    mediaReport.value = createMediaCompletenessReport([...audioMediaIssues, ...midiMediaIssues]);
    if (options.mediaWarning) {
      options.mediaWarning.value = mediaReport.value.complete
        ? ''
        : `${options.mediaWarningIntro?.value ?? 'Some project media could not be played. Open Media to relink or replace it.'}\n${formatMediaCompletenessReport(mediaReport.value)}`;
    }
  }

  function mergeScheduledOwnership(clips: ReadonlyArray<ScheduledProjectClip>): void {
    const byId = new Map(scheduledClips.map((clip) => [clip.engineClipId, clip]));
    for (const clip of clips) byId.set(clip.engineClipId, clip);
    scheduledClips = [...byId.values()];
    scheduledCount.value = scheduledClips.length;
  }

  function requestEngineRebuild(): void {
    engineRebuildRequired.value = true;
    if (!engineRebuildHandler) return;
    void Promise.resolve(engineRebuildHandler()).catch((error) => {
      errorMessage.value = describeError(error);
    });
  }

  async function applyToEngine(applyOptions: ApplyToEngineOptions = {}): Promise<void> {
    const h = applyOptions.handle ?? handle.value;
    if (!h || !store.initialized) return;
    const stagedHandle = applyOptions.handle !== undefined;
    applyController?.abort(new DOMException('Audio schedule apply superseded.', 'AbortError'));
    const controller = new AbortController();
    applyController = controller;
    const generation = ++applyGeneration;
    applyPending.value = false;
    const mediaIssues: MediaCompletenessIssue[] = [];
    try {
      const next = await scheduleProjectClips(h, {
        signal: controller.signal,
        retainedScheduleBytes: scheduledClips.reduce(
          (sum, clip) => sum + (clip.payloadBytes ?? 0),
          0,
        ),
        onMediaIssue: (issue) => mediaIssues.push(issue),
      });
      if (
        controller.signal.aborted ||
        generation !== applyGeneration ||
        (!stagedHandle && handle.value !== h)
      ) {
        const cleanup = cleanupScheduledProjectClips(h, next);
        if (!stagedHandle && cleanup.failures.length > 0) {
          mergeScheduledOwnership(cleanup.remaining);
          requestEngineRebuild();
        }
        return;
      }
      scheduledClips = replaceScheduledProjectClips(h, scheduledClips, next);
      scheduledCount.value = next.length;
      engineRebuildRequired.value = false;
      audioMediaIssues = mediaIssues;
      publishMediaReport();
    } catch (err) {
      if (err instanceof AudioScheduleReplaceError) {
        scheduledClips = err.ownedClips;
        scheduledCount.value = scheduledClips.length;
        if (!stagedHandle) requestEngineRebuild();
      }
      if (controller.signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
        if (applyOptions.throwOnError) throw err;
        return;
      }
      errorMessage.value = describeError(err);
      if (applyOptions.throwOnError) throw err;
    } finally {
      if (applyController === controller) applyController = null;
    }
  }

  function scheduleApply(): void {
    if (!handle.value) return;
    applyGeneration += 1;
    applyController?.abort(new DOMException('Audio schedule source changed.', 'AbortError'));
    applyPending.value = true;
    if (applyTimer !== null) clearTimeout(applyTimer);
    applyTimer = setTimeout(() => {
      applyTimer = null;
      void applyToEngine();
    }, APPLY_DEBOUNCE_MS);
  }

  function scheduleInstrumentScrubSync(): void {
    if (instrumentScrubTimer !== null) clearTimeout(instrumentScrubTimer);
    instrumentScrubTimer = setTimeout(() => {
      instrumentScrubTimer = null;
      void syncMidiState();
    }, INSTRUMENT_SCRUB_DEBOUNCE_MS);
  }

  function syncMixerState(syncOptions: InitialEngineSyncOptions = {}): void {
    try {
      if (!mixerSync || !stripSync || !store.initialized) return;
      const vcaGroups = store.mixer.vcaGroups ?? [];
      const vcaGainDb = vcaGroups.length
        ? new Map(vcaGroups.map((group) => [group.id, group.gainDb]))
        : undefined;
      const vcaControls = vcaGroups.length
        ? new Map(vcaGroups.map((group) => [group.id, group]))
        : undefined;
      mixerSync.sync(
        store.tracks,
        store.mixer.master,
        vcaGainDb,
        vcaControls,
        store.mixer.soloMode,
      );
      stripSync.sync(store.tracks, store.mixer);
    } catch (err) {
      errorMessage.value = describeError(err);
      if (syncOptions.throwOnError) throw err;
    }
  }

  function syncAutomationState(syncOptions: InitialEngineSyncOptions = {}): void {
    try {
      if (!automationSync || !store.initialized) return;
      automationSync.sync(
        store.automationLanes.filter((lane) => isAutomationStripPlaybackEnabled(lane.target)),
      );
    } catch (err) {
      errorMessage.value = describeError(err);
      if (syncOptions.throwOnError) throw err;
    }
  }

  function trackMeterSource(trackId: number): MeterSource | null {
    const b = bridge.value;
    const sync = mixerSync;
    if (!b || !sync) return null;
    const laneIndex = sync.laneTrackIds().indexOf(trackId);
    // Lanes past the meter range would alias into the bus target ids (33+), so
    // report no meter rather than another strip's levels.
    if (laneIndex < 0 || laneIndex >= MAX_LANE_METER_TARGETS) return null;
    return b.forTarget(laneMeterTargetId(laneIndex));
  }

  function busMeterSource(storeBusId: string): MeterSource | null {
    const b = bridge.value;
    const sync = stripSync;
    if (!b || !sync) return null;
    const busNumber = sync.busIdFor(storeBusId);
    if (busNumber === undefined) return null;
    const busIndex = busNumber - 1;
    if (busIndex < 0 || busIndex >= MAX_BUS_METER_TARGETS) return null;
    return b.forTarget(busMeterTargetId(busIndex));
  }

  /** Master-output scope source (spectrum + goniometer), or null pre-engine. */
  function masterScopeSource(): ScopeSource | null {
    return scope.value?.forTarget(MASTER_METER_TARGET_ID) ?? null;
  }

  /** Per-track scope source, addressed by the same lane id the meters use. */
  function trackScopeSource(trackId: number): ScopeSource | null {
    const s = scope.value;
    const sync = mixerSync;
    if (!s || !sync) return null;
    const laneIndex = sync.laneTrackIds().indexOf(trackId);
    // Same lane-range guard as trackMeterSource: no aliasing into bus targets.
    if (laneIndex < 0 || laneIndex >= MAX_LANE_METER_TARGETS) return null;
    return s.forTarget(laneMeterTargetId(laneIndex));
  }

  /** Per-bus scope source, addressed by the same bus id the meters use. */
  function busScopeSource(storeBusId: string): ScopeSource | null {
    const s = scope.value;
    const sync = stripSync;
    if (!s || !sync) return null;
    const busNumber = sync.busIdFor(storeBusId);
    if (busNumber === undefined) return null;
    const busIndex = busNumber - 1;
    if (busIndex < 0 || busIndex >= MAX_BUS_METER_TARGETS) return null;
    return s.forTarget(busMeterTargetId(busIndex));
  }

  function effectiveTempoSegments(): { startPpq: number; bpm: number; endBpm?: number }[] {
    return store.tempoSegments.length > 0
      ? store.tempoSegments.map((segment) => ({ ...segment }))
      : [{ startPpq: 0, bpm: store.tempoBpm }];
  }

  function syncTransportState(syncOptions: InitialEngineSyncOptions = {}): void {
    try {
      if (!transportSync || !store.initialized) return;
      transportSync.sync(store.tempoSegments, store.timeSignatures, store.markers);
      transport.setTempoMap(effectiveTempoSegments());
    } catch (err) {
      errorMessage.value = describeError(err);
      if (syncOptions.throwOnError) throw err;
    }
  }

  function syncMidiState(syncOptions: InitialEngineSyncOptions = {}): Promise<void> {
    const m = midiSync;
    if (!m || !store.initialized) return midiSyncQueue;
    // Instrument binding targets engine lanes by track id. When a MIDI file is
    // imported while the engine is already running, the MIDI watcher can fire
    // before the track/mixer watcher declares the new lanes, so declare them
    // here as a precondition of binding instruments.
    syncMixerState();
    // Keep the external-MIDI routing table in step with the tracks' instruments
    // so drained events reach the right port/channel.
    webMidiOutput?.syncRoutes(store.tracks, store.projectExternalMidi);
    const operation = midiSyncQueue.then(async () => {
      await m.sync(
        store.tracks,
        store.clips,
        effectiveTempoSegments(),
        store.projectExternalMidi,
        store.automationLanes,
        transport.positionPpq?.value ?? 0,
      );
      midiMediaIssues = (m.mediaIssues?.() ?? []).map((issue) => ({
        ...issue,
        projectName: store.projectName,
      }));
      publishMediaReport();
    });
    midiSyncQueue = operation.catch((err) => {
      errorMessage.value = describeError(err);
    });
    return syncOptions.throwOnError ? operation : midiSyncQueue;
  }

  function applyNow(): void {
    if (applyTimer !== null) {
      clearTimeout(applyTimer);
      applyTimer = null;
    }
    void applyToEngine();
  }

  /** Routes a live channel-voice message directly to an external MIDI track. */
  function sendLiveExternalMidi(
    destinationId: number,
    bytes: ReadonlyArray<number>,
    timestampMs?: number,
  ): boolean {
    return webMidiOutput?.sendLive(destinationId, bytes, timestampMs) ?? false;
  }

  function setEngineSyncHandles(handles: EngineSyncHandles): void {
    mixerSync = handles.mixerSync;
    stripSync = handles.stripSync;
    automationSync = handles.automationSync;
    midiSync = handles.midiSync;
    transportSync = handles.transportSync;
    webMidiOutput = handles.webMidiOutput;
  }

  function disposeEngineProjectSync(): void {
    applyGeneration++;
    applyController?.abort(new DOMException('Engine project sync disposed.', 'AbortError'));
    applyController = null;
    if (applyTimer !== null) {
      clearTimeout(applyTimer);
      applyTimer = null;
    }
    if (instrumentScrubTimer !== null) {
      clearTimeout(instrumentScrubTimer);
      instrumentScrubTimer = null;
    }
    scheduledClips = [];
    scheduledCount.value = 0;
    mixerSync = null;
    stripSync = null;
    automationSync = null;
    midiSync = null;
    transportSync = null;
    webMidiOutput?.dispose();
    webMidiOutput = null;
  }

  watch(
    () =>
      [
        store.clips.filter(isAudioClip).map(clipScheduleKey).join('\n'),
        JSON.stringify(effectiveTempoSegments()),
      ].join('\0'),
    (next, prev) => {
      if (next !== prev) scheduleApply();
    },
  );
  watch(
    () => store.tracks.map(trackScheduleKey).join('\n'),
    (next, prev) => {
      if (next !== prev) scheduleApply();
    },
  );
  watch(
    () =>
      [
        store.clips
          .filter((clip) => !isAudioClip(clip))
          .map(clipScheduleKey)
          .join('\n'),
        store.tracks.map(trackMidiSyncKey).join('\n'),
        instrumentAutomationSyncKey(store.automationLanes),
        JSON.stringify(effectiveTempoSegments()),
      ].join('\0'),
    (next, prev) => {
      if (next !== prev) syncMidiState();
    },
    { flush: 'sync' },
  );
  watch(
    () => transport.positionPpq?.value ?? 0,
    (next, prev) => {
      // Synth-patch instrument automation resolves to a single start-position
      // value: the engine defers instrument syncs during playback and bursts
      // them on stop (the offline render likewise bakes the value at the range
      // start). Re-evaluating on every playback frame therefore never sounds
      // live and only floods that deferred queue while re-running a full MIDI
      // sync + JSON.stringify each frame. Re-bake only while parked, when a seek
      // moves the playhead, so the next playback starts from the correct value
      // without per-frame churn.
      if (
        next !== prev &&
        transport.isPlaying?.value !== true &&
        hasInstrumentAutomation(store.automationLanes)
      ) {
        scheduleInstrumentScrubSync();
      }
    },
    { flush: 'sync' },
  );
  watch(
    () => JSON.stringify(store.projectExternalMidi),
    (next, prev) => {
      if (next !== prev) syncMidiState();
    },
    { flush: 'sync' },
  );
  watch(
    () => store.tracks,
    () => {
      syncMixerState();
      syncAutomationState();
    },
  );
  watch(
    () => store.mixer,
    () => {
      syncMixerState();
      syncAutomationState();
    },
  );
  watch(
    () => JSON.stringify(store.automationLanes),
    (next, prev) => {
      if (next !== prev) syncAutomationState();
    },
  );
  watch(
    () => automationStripModeRevision(),
    (next, prev) => {
      if (next !== prev) syncAutomationState();
    },
  );
  watch(
    () => store.documentGeneration,
    (next, previous) => {
      if (next !== previous) resetAutomationStripModes();
    },
  );
  watch(
    () =>
      [
        JSON.stringify(store.tempoSegments),
        JSON.stringify(store.timeSignatures),
        JSON.stringify(store.markers),
      ].join('|'),
    (next, prev) => {
      if (next !== prev) syncTransportState();
    },
  );

  return {
    applyPending,
    scheduledCount,
    mediaReport,
    applyNow,
    applyToEngine,
    busMeterSource,
    busScopeSource,
    masterScopeSource,
    trackScopeSource,
    disposeEngineProjectSync,
    effectiveTempoSegments,
    engineRebuildRequired,
    hasMidiSync: () => midiSync !== null,
    scheduleApply,
    sendLiveExternalMidi,
    scheduledClips: () => scheduledClips,
    setEngineRebuildHandler: (handler: (() => void | Promise<void>) | null) => {
      engineRebuildHandler = handler;
    },
    setEngineSyncHandles,
    syncAutomationState,
    syncMidiState,
    syncMixerState,
    syncTransportState,
    trackMeterSource,
    automationSync: () => automationSync,
    midiSync: () => midiSync,
    mixerLaneTrackIds: () => mixerSync?.laneTrackIds() ?? [],
  };
}

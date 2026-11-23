import { computed, ref, type ShallowRef, shallowRef, watch } from 'vue';
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
import { describeError, isAbortError } from '@/lib/errors';
import { clipArticulations } from '@/project/annotations';
import {
  createMediaCompletenessReport,
  formatMediaCompletenessReport,
  type MediaCompletenessIssue,
  type MediaCompletenessReport,
} from '@/project/media-completeness';
import { MAX_TRACK_LANES } from '@/project/mixer';
import {
  AudioScheduleReplaceError,
  discardUnownedScheduledClips,
  replaceScheduledProjectClips,
  type ScheduledProjectClip,
  scheduleProjectClips,
} from '@/project/scheduling';
import { useProjectStore } from '@/project/store';
import { type EditorClip, type EditorTrack, isAudioClip } from '@/project/types';
import { formatMessage, useI18n } from '@/ui/i18n';
import {
  automationStripModeRevision,
  isAutomationStripPlaybackEnabled,
  resetAutomationStripModes,
} from '@/ui/mixer/automation-mode';
import { createSidechainRefusalLookup } from '@/ui/mixer/sidechain-refusal';

const APPLY_DEBOUNCE_MS = 400;
/** Collapse continuous MIDI editing before rebuilding the engine's full MIDI state. */
const MIDI_SYNC_DEBOUNCE_MS = 100;

type Transport = ReturnType<typeof useTransport>;

export interface EngineProjectSyncOptions {
  bridge: ShallowRef<MeterBridge | null>;
  scope: ShallowRef<ScopeBridge | null>;
  errorMessage: { value: string };
  mediaWarning?: { value: string };
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

export function useEngineProjectSync(options: EngineProjectSyncOptions) {
  const { bridge, scope, errorMessage, handle, transport } = options;
  const { t } = useI18n();
  const store = useProjectStore();

  let scheduledClips: ScheduledProjectClip[] = [];
  let mixerSync: MixerSync | null = null;
  let stripSync: StripSync | null = null;
  let automationSync: AutomationSync | null = null;
  let midiSync: MidiSync | null = null;
  let transportSync: TransportSync | null = null;
  let webMidiOutput: WebMidiOutputBridge | null = null;
  // Reactive mirror of stripSync for lookups that follow the engine's lifetime.
  const installedStripSync = shallowRef<StripSync | null>(null);
  let applyGeneration = 0;
  let applyController: AbortController | null = null;
  let applyTimer: ReturnType<typeof setTimeout> | null = null;
  let midiSyncTimer: ReturnType<typeof setTimeout> | null = null;
  let engineRebuildHandler: (() => void | Promise<void>) | null = null;
  let midiSyncQueue: Promise<void> = Promise.resolve();
  let applyRun: Promise<void> = Promise.resolve();
  const idleWaiters: Array<() => void> = [];
  let audioMediaIssues: MediaCompletenessIssue[] = [];
  let midiMediaIssues: MediaCompletenessIssue[] = [];
  /** Overflow count last reported, so the notice is set once per change. */
  let reportedLaneOverflow = 0;

  const scheduledCount = ref(0);
  const applyPending = ref(false);
  const engineRebuildRequired = ref(false);
  const mediaReport = ref<MediaCompletenessReport>(createMediaCompletenessReport());

  function publishMediaReport(): void {
    mediaReport.value = createMediaCompletenessReport([...audioMediaIssues, ...midiMediaIssues]);
    if (options.mediaWarning) {
      options.mediaWarning.value = mediaReport.value.complete
        ? ''
        : `${t.value.shell.media.missingWarning}\n${formatMediaCompletenessReport(mediaReport.value)}`;
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
      errorMessage.value = describeError(error, t.value.notices.errors);
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
        previous: scheduledClips,
        onMediaIssue: (issue) => mediaIssues.push(issue),
      });
      if (
        controller.signal.aborted ||
        generation !== applyGeneration ||
        (!stagedHandle && handle.value !== h)
      ) {
        const cleanup = discardUnownedScheduledClips(h, scheduledClips, next);
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
      if (controller.signal.aborted || isAbortError(err)) {
        if (applyOptions.throwOnError) throw err;
        return;
      }
      errorMessage.value = describeError(err, t.value.notices.errors);
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
      startApply();
    }, APPLY_DEBOUNCE_MS);
  }

  /** Collapses a burst of MIDI content edits into one full engine sync. */
  function scheduleMidiSync(): void {
    if (!midiSync || !store.initialized) return;
    if (midiSyncTimer !== null) clearTimeout(midiSyncTimer);
    midiSyncTimer = setTimeout(() => {
      midiSyncTimer = null;
      void syncMidiState();
      wakeIdleWaiters();
    }, MIDI_SYNC_DEBOUNCE_MS);
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
        store.mixer.buses,
      );
      // Until the rebuild reclaims retired lanes, and for tracks past the lane
      // cap, a track has no lane to strip.
      const reclaimLanes = mixerSync.laneReclaimNeeded?.() === true;
      const overflow = mixerSync.laneOverflowCount?.() ?? 0;
      if (overflow > 0 && overflow !== reportedLaneOverflow) {
        errorMessage.value = formatMessage(t.value.notices.trackLaneOverflow, {
          count: overflow,
          limit: MAX_TRACK_LANES,
        });
      }
      reportedLaneOverflow = overflow;
      const lanes = new Set(mixerSync.laneTrackIds());
      stripSync.sync(
        reclaimLanes || overflow > 0
          ? store.tracks.filter((track) => lanes.has(track.id))
          : store.tracks,
        store.mixer,
        mixerSync.sceneGeneration?.(),
        mixerSync.positiveChannelDelayTrackIds(),
      );
      mixerSync.applyChannelDelays(stripSync.sceneGeneration());
      if (reclaimLanes && !engineRebuildRequired.value) requestEngineRebuild();
    } catch (err) {
      errorMessage.value = describeError(err, t.value.notices.errors);
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
      errorMessage.value = describeError(err, t.value.notices.errors);
      if (syncOptions.throwOnError) throw err;
    }
  }

  /** Engine target id of a track's lane, or null when it has no in-range lane. */
  function laneTargetId(trackId: number): number | null {
    const laneIndex = mixerSync?.laneTrackIds().indexOf(trackId) ?? -1;
    // Lanes past the meter range would alias into the bus target ids (33+), so
    // report no target rather than another strip's.
    if (laneIndex < 0 || laneIndex >= MAX_LANE_METER_TARGETS) return null;
    return laneMeterTargetId(laneIndex);
  }

  /** Engine target id of a store bus, or null when it is undeclared or out of range. */
  function busTargetId(storeBusId: string): number | null {
    const busNumber = stripSync?.busIdFor(storeBusId);
    if (busNumber === undefined) return null;
    const busIndex = busNumber - 1;
    if (busIndex < 0 || busIndex >= MAX_BUS_METER_TARGETS) return null;
    return busMeterTargetId(busIndex);
  }

  function trackMeterSource(trackId: number): MeterSource | null {
    const targetId = laneTargetId(trackId);
    return targetId === null ? null : (bridge.value?.forTarget(targetId) ?? null);
  }

  function busMeterSource(storeBusId: string): MeterSource | null {
    const targetId = busTargetId(storeBusId);
    return targetId === null ? null : (bridge.value?.forTarget(targetId) ?? null);
  }

  /** Master-output scope source (spectrum + goniometer), or null pre-engine. */
  function masterScopeSource(): ScopeSource | null {
    return scope.value?.forTarget(MASTER_METER_TARGET_ID) ?? null;
  }

  /** Per-track scope source, addressed by the same lane id the meters use. */
  function trackScopeSource(trackId: number): ScopeSource | null {
    const targetId = laneTargetId(trackId);
    return targetId === null ? null : (scope.value?.forTarget(targetId) ?? null);
  }

  /** Per-bus scope source, addressed by the same bus id the meters use. */
  function busScopeSource(storeBusId: string): ScopeSource | null {
    const targetId = busTargetId(storeBusId);
    return targetId === null ? null : (scope.value?.forTarget(targetId) ?? null);
  }

  function effectiveTempoSegments(): { startPpq: number; bpm: number; endBpm?: number }[] {
    return store.tempoSegments.length > 0
      ? store.tempoSegments.map((segment) => ({ ...segment }))
      : [{ startPpq: 0, bpm: store.tempoBpm }];
  }

  /** Serialized effective tempo, shared by every watcher keyed on tempo changes. */
  const effectiveTempoKey = computed(() => JSON.stringify(effectiveTempoSegments()));

  function syncTransportState(syncOptions: InitialEngineSyncOptions = {}): void {
    try {
      if (!transportSync || !store.initialized) return;
      transportSync.sync(store.tempoSegments, store.timeSignatures, store.markers);
      transport.setTempoMap(effectiveTempoSegments());
    } catch (err) {
      errorMessage.value = describeError(err, t.value.notices.errors);
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
        clipArticulations(store.scoreAnnotations),
      );
      // A swapped instrument starts from default channel state; while playing,
      // resend the program/bank/controllers in effect at the playhead.
      const rebound = m.reboundDestinations?.();
      if (rebound && rebound.size > 0 && transport.isPlaying.value) {
        m.restoreStateAtPpq(transport.positionPpq.value, undefined, rebound);
      }
      // Instrument automation ids resolve only once an instrument is bound.
      syncAutomationState();
      midiMediaIssues = (m.mediaIssues?.() ?? []).map((issue) => ({
        ...issue,
        projectName: store.projectName,
      }));
      publishMediaReport();
    });
    midiSyncQueue = operation.catch((err) => {
      errorMessage.value = describeError(err, t.value.notices.errors);
    });
    return syncOptions.throwOnError ? operation : midiSyncQueue;
  }

  function applyNow(): void {
    if (applyTimer !== null) {
      clearTimeout(applyTimer);
      applyTimer = null;
    }
    if (midiSyncTimer !== null) {
      clearTimeout(midiSyncTimer);
      midiSyncTimer = null;
      void syncMidiState();
    }
    startApply();
  }

  /** Runs one audio-schedule apply and records it for whenEngineSyncIdle. */
  function startApply(): void {
    applyRun = applyToEngine();
    wakeIdleWaiters();
  }

  function wakeIdleWaiters(): void {
    for (const wake of idleWaiters.splice(0)) wake();
  }

  /**
   * Resolves once no debounced engine sync is waiting on its timer and the
   * audio-schedule apply and MIDI sync it started have settled.
   */
  async function whenEngineSyncIdle(): Promise<void> {
    for (;;) {
      if (applyTimer !== null || midiSyncTimer !== null) {
        await new Promise<void>((resolve) => idleWaiters.push(resolve));
        continue;
      }
      const apply = applyRun;
      const midi = midiSyncQueue;
      await Promise.all([apply.catch(() => undefined), midi]);
      if (
        applyTimer === null &&
        midiSyncTimer === null &&
        apply === applyRun &&
        midi === midiSyncQueue
      ) {
        return;
      }
    }
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
    installedStripSync.value = handles.stripSync;
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
    if (midiSyncTimer !== null) {
      clearTimeout(midiSyncTimer);
      midiSyncTimer = null;
    }
    wakeIdleWaiters();
    scheduledClips = [];
    scheduledCount.value = 0;
    mixerSync = null;
    stripSync = null;
    installedStripSync.value = null;
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
        effectiveTempoKey.value,
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
        effectiveTempoKey.value,
      ].join('\0'),
    (next, prev) => {
      if (next !== prev) scheduleMidiSync();
    },
  );
  watch(
    () => JSON.stringify(store.projectExternalMidi),
    (next, prev) => {
      if (next !== prev) syncMidiState();
    },
    // Commands refresh the mirror synchronously after changing this route;
    // wait for that refresh so the route sees the same tracks as the UI.
    { flush: 'post' },
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

  /** Why the running engine would refuse an insert sidechain key; null without an engine. */
  const sidechainRefusal = computed(() => {
    const h = handle.value;
    const ids = installedStripSync.value;
    return h && ids ? createSidechainRefusalLookup(h.engine, ids, () => store.tracks) : null;
  });

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
    whenEngineSyncIdle,
    automationSync: () => automationSync,
    midiSync: () => midiSync,
    mixerLaneTrackIds: () => mixerSync?.laneTrackIds() ?? [],
    sidechainRefusal,
  };
}

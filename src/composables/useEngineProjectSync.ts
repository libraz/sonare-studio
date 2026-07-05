import { ref, type ShallowRef, watch } from 'vue';
import type { useTransport } from '@/composables/useTransport';
import type { AutomationSync } from '@/engine/automation-sync';
import type { EngineHandle } from '@/engine/engine';
import {
  busMeterTargetId,
  MASTER_METER_TARGET_ID,
  MAX_BUS_METER_TARGETS,
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
import type { ScheduledProjectClip } from '@/project/scheduling';
import { scheduleProjectClips } from '@/project/scheduling';
import { useProjectStore } from '@/project/store';
import { type EditorClip, type EditorTrack, isAudioClip } from '@/project/types';
import { automationStripMode, automationStripModeRevision } from '@/ui/mixer/automation-mode';

const APPLY_DEBOUNCE_MS = 400;

type Transport = ReturnType<typeof useTransport>;

export interface EngineProjectSyncOptions {
  bridge: ShallowRef<MeterBridge | null>;
  scope: ShallowRef<ScopeBridge | null>;
  errorMessage: { value: string };
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
  let applyTimer: ReturnType<typeof setTimeout> | null = null;
  let midiSyncQueue: Promise<void> = Promise.resolve();

  const scheduledCount = ref(0);
  const applyPending = ref(false);

  async function applyToEngine(): Promise<void> {
    const h = handle.value;
    if (!h || !store.initialized) return;
    const generation = ++applyGeneration;
    applyPending.value = false;
    try {
      const next = await scheduleProjectClips(h);
      if (generation !== applyGeneration || handle.value !== h) {
        for (const clip of next) h.engine.removeClip(clip.engineClipId);
        return;
      }
      for (const clip of scheduledClips) h.engine.removeClip(clip.engineClipId);
      scheduledClips = next;
      scheduledCount.value = next.length;
    } catch (err) {
      errorMessage.value = describeError(err);
    }
  }

  function scheduleApply(): void {
    if (!handle.value) return;
    applyPending.value = true;
    if (applyTimer !== null) clearTimeout(applyTimer);
    applyTimer = setTimeout(() => {
      applyTimer = null;
      void applyToEngine();
    }, APPLY_DEBOUNCE_MS);
  }

  function syncMixerState(): void {
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
    }
  }

  function syncAutomationState(): void {
    try {
      if (!automationSync || !store.initialized) return;
      automationSync.sync(
        store.automationLanes.filter((lane) => automationStripMode(lane.target) !== 'off'),
      );
    } catch (err) {
      errorMessage.value = describeError(err);
    }
  }

  function trackMeterSource(trackId: number): MeterSource | null {
    const b = bridge.value;
    const sync = mixerSync;
    if (!b || !sync) return null;
    const laneIndex = sync.laneTrackIds().indexOf(trackId);
    return laneIndex >= 0 ? b.forTarget(laneIndex + 1) : null;
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
    return laneIndex >= 0 ? s.forTarget(laneIndex + 1) : null;
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

  function syncTransportState(): void {
    try {
      if (!transportSync || !store.initialized) return;
      transportSync.sync(store.tempoSegments, store.timeSignatures, store.markers);
      transport.setTempoMap(effectiveTempoSegments());
    } catch (err) {
      errorMessage.value = describeError(err);
    }
  }

  function syncMidiState(): Promise<void> {
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
    midiSyncQueue = midiSyncQueue
      .then(() =>
        m.sync(
          store.tracks,
          store.clips,
          effectiveTempoSegments(),
          store.projectExternalMidi,
          store.automationLanes,
          transport.positionPpq?.value ?? 0,
        ),
      )
      .catch((err) => {
        errorMessage.value = describeError(err);
      });
    return midiSyncQueue;
  }

  function applyNow(): void {
    if (applyTimer !== null) {
      clearTimeout(applyTimer);
      applyTimer = null;
    }
    void applyToEngine();
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
    if (applyTimer !== null) {
      clearTimeout(applyTimer);
      applyTimer = null;
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
    () => store.clips.filter(isAudioClip).map(clipScheduleKey).join('\n'),
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
      if (next !== prev && hasInstrumentAutomation(store.automationLanes)) syncMidiState();
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
    applyNow,
    applyToEngine,
    busMeterSource,
    busScopeSource,
    masterScopeSource,
    trackScopeSource,
    disposeEngineProjectSync,
    effectiveTempoSegments,
    hasMidiSync: () => midiSync !== null,
    scheduleApply,
    scheduledClips: () => scheduledClips,
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

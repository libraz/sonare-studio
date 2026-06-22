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
import { describeError } from '@/lib/errors';
import type { ScheduledProjectClip } from '@/project/scheduling';
import { scheduleProjectClips } from '@/project/scheduling';
import { useProjectStore } from '@/project/store';
import { type EditorClip, type EditorTrack, isAudioClip } from '@/project/types';

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
}

function trackScheduleKey(track: EditorTrack): string {
  return `${track.id}|${track.kind}|${track.frozen?.assetId ?? ''}`;
}

function clipScheduleKey(clip: EditorClip): string {
  const { name: _name, ...rest } = clip;
  return JSON.stringify(rest);
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
    if (!mixerSync || !stripSync || !store.initialized) return;
    const vcaGroups = store.mixer.vcaGroups ?? [];
    const vcaGainDb = vcaGroups.length
      ? new Map(vcaGroups.map((group) => [group.id, group.gainDb]))
      : undefined;
    mixerSync.sync(store.tracks, store.mixer.master, vcaGainDb);
    stripSync.sync(store.tracks, store.mixer);
  }

  function syncAutomationState(): void {
    if (!automationSync || !store.initialized) return;
    automationSync.sync(store.automationLanes);
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
    if (!transportSync || !store.initialized) return;
    transportSync.sync(store.tempoSegments, store.timeSignatures, store.markers);
    transport.setTempoMap(effectiveTempoSegments());
  }

  function syncMidiState(): void {
    const m = midiSync;
    if (!m || !store.initialized) return;
    midiSyncQueue = midiSyncQueue
      .then(() => m.sync(store.tracks, store.clips, effectiveTempoSegments()))
      .catch((err) => {
        errorMessage.value = describeError(err);
      });
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
  }

  function disposeEngineProjectSync(): void {
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
        store.tracks
          .map(
            (track) =>
              `${track.id}|${JSON.stringify(track.instrument ?? null)}|${track.frozen?.assetId ?? ''}`,
          )
          .join('\n'),
        JSON.stringify(effectiveTempoSegments()),
      ].join('\0'),
    (next, prev) => {
      if (next !== prev) syncMidiState();
    },
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

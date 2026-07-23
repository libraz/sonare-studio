import type { Ref, ShallowRef } from 'vue';
import type { useRecording } from '@/composables/useRecording';
import type { useTransport } from '@/composables/useTransport';
import type { AutomationSync } from '@/engine/automation-sync';
import type { EngineHandle } from '@/engine/engine';
import { peakAmplitude, prerenderMidiClip } from '@/engine/instruments';
import type { MeterBridge, MeterSource } from '@/engine/meters';
import type { MidiSync } from '@/engine/midi-sync';
import { renderMixdownInWorker } from '@/export/client';
import { encodeWav } from '@/export/wav';
import { peakDb } from '@/lib/db';
import { ingestAudioBuffer } from '@/project/audio-import';
import type { AutomationParam, AutomationPoint, AutomationTarget } from '@/project/automation';
import {
  addAudioClip,
  addAudioTrack,
  addGroupTrack,
  addInsert,
  addMixerBus,
  deleteClip,
  removeAutomationLane,
  removeInsert,
  removeMixerBus,
  removeTrack,
  setAutomationLanePoints,
  setClipActiveTake,
  setClipCompSegments,
  setClipTakes,
  setClipWarp,
  setInsertEnabled,
  setInsertSidechain,
  setSend,
  setStripGain,
  setTempoSegments,
  setTrackGroup,
} from '@/project/commands';
import { flattenClipComp } from '@/project/comp-flatten';
import { bounceTrackRange, freezeTrack, unfreezeTrack } from '@/project/freeze';
import type { ScheduledProjectClip } from '@/project/scheduling';
import { serializeProject } from '@/project/serialization';
import type { useProjectStore } from '@/project/store';
import type { WarpAnchor } from '@/project/types';
import { clipKind, isAudioClip } from '@/project/types';
import {
  type AutomationStripMode,
  automationStripMode,
  setAutomationStripMode,
} from '@/ui/mixer/automation-mode';

type ProjectStore = ReturnType<typeof useProjectStore>;
type Recording = ReturnType<typeof useRecording>;
type Transport = ReturnType<typeof useTransport>;

export interface DevDebugContext {
  store: ProjectStore;
  recording: Recording;
  transport: Transport;
  handle: ShallowRef<EngineHandle | null>;
  bridge: ShallowRef<MeterBridge | null>;
  applyPending: Ref<boolean>;
  errorMessage: Ref<string>;
  positionPpq: Ref<number>;
  lastDownload: () => { filename: string; blob: Blob } | null;
  scheduledClips: () => ScheduledProjectClip[];
  midiSync: () => MidiSync | null;
  automationSync: () => AutomationSync | null;
  trackMeterSource: (trackId: number) => MeterSource | null;
}

function peakOf(channels: Float32Array[]): number {
  let peak = 0;
  for (const channel of channels) {
    for (const sample of channel) {
      const a = Math.abs(sample);
      if (a > peak) peak = a;
    }
  }
  return peakDb(peak);
}

function fnv1a(bytes: Uint8Array): string {
  let hash = 0x811c9dc5;
  for (const byte of bytes) hash = Math.imul(hash ^ byte, 0x01000193);
  return (hash >>> 0).toString(16);
}

async function ingestTone(
  sampleRate: number,
  seconds: number,
  frequencyHz: number,
  amplitude: number,
): Promise<string> {
  const frames = Math.round(seconds * sampleRate);
  const data = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    data[i] = Math.sin((2 * Math.PI * frequencyHz * i) / sampleRate) * amplitude;
  }
  const meta = await ingestAudioBuffer([data], sampleRate, `tone-${frequencyHz}`, {
    analysis: null,
  });
  return meta.id;
}

export function installSonareDevDebug(ctx: DevDebugContext): void {
  const { store, recording, transport, handle, bridge, applyPending, errorMessage, positionPpq } =
    ctx;

  (window as { __sonareDebug?: unknown }).__sonareDebug = {
    noteCount: () => store.notes.length,
    selectionCount: () => store.selection.size,
    initialized: () => store.initialized,
    engineStarted: () => handle.value !== null,
    trackCount: () => store.tracks.length,
    trackIds: () => store.tracks.map((track) => track.id),
    clipCount: () => store.clips.length,
    clipKinds: () => store.clips.map((clip) => clipKind(clip)),
    audioClipCount: () => store.clips.filter((clip) => isAudioClip(clip)).length,
    armedTrackId: () => recording.armedTrackId.value,
    recordingState: () => recording.state.value,
    isRecording: () => recording.isRecording.value,
    inputLevel: () => recording.inputLevel.value,
    setInputMonitor: (enabled: boolean) => recording.setMonitor(enabled),
    projectName: () => store.projectName,
    activeTrackId: () => store.activeTrackId,
    activeClipId: () => store.clipId,
    applyPending: () => applyPending.value,
    scheduledClipIds: () => ctx.scheduledClips().map((clip) => clip.engineClipId),
    engineMidiClipCount: () => ctx.midiSync()?.scheduledClipCount() ?? 0,
    trackInstruments: () =>
      store.tracks.map((track) =>
        track.instrument === undefined
          ? null
          : track.instrument.kind === 'synth-preset'
            ? track.instrument.preset
            : track.instrument.kind,
      ),
    trackInsertCounts: () => store.tracks.map((track) => track.mixer?.inserts.length ?? 0),
    trackInsertSidechains: () =>
      store.tracks.map((track) =>
        (track.mixer?.inserts ?? []).map((slot) => slot.sidechainSourceTrackId ?? null),
      ),
    trackInsertStates: () =>
      store.tracks.map((track) => (track.mixer?.inserts ?? []).map((slot) => slot.enabled)),
    masterInsertCount: () => store.mixer.master.inserts.length,
    addMasterInsert: (processor: string, params?: Record<string, number | boolean>) =>
      addInsert('master', processor, params),
    setMasterInsertEnabled: (index: number, enabled: boolean) =>
      setInsertEnabled('master', index, enabled),
    removeMasterInsert: (index: number) => removeInsert('master', index),
    masteringProcessors: () =>
      (store.mixer.masteringChain?.processors ?? []).map((slot) => slot.processor),
    lastDownload: () => ctx.lastDownload(),
    exportProbe: async (
      includeMasterChain = true,
      range?: { startPpq: number; endPpq: number },
      stems = false,
    ) => {
      const result = await renderMixdownInWorker(serializeProject(), {
        includeMasterChain,
        ...(range !== undefined ? { range } : {}),
        ...(stems ? { stems } : {}),
      }).result;
      const wav = encodeWav(result.channels, result.sampleRate, { bitDepth: 16 });
      return {
        totalFrames: result.totalFrames,
        sampleRate: result.sampleRate,
        peakDb: result.report.peakDb,
        truePeakDb: result.report.truePeakDb ?? null,
        lufs: result.report.lufs ?? null,
        wavBytes: wav.length,
        riff: String.fromCharCode(wav[0], wav[1], wav[2], wav[3]),
        hash: fnv1a(wav),
        stems:
          result.stems?.map((stem) => ({
            trackIndex: stem.trackIndex,
            name: stem.name,
            peakDb: peakOf(stem.channels),
          })) ?? null,
      };
    },
    lastError: () => errorMessage.value,
    meterPeakDb: () => {
      const latest = bridge.value?.latest;
      return latest ? Math.max(latest.peakDbL, latest.peakDbR) : null;
    },
    trackMeterDb: (trackId: number) => {
      const source = ctx.trackMeterSource(trackId);
      return source ? Math.max(source.latest.peakDbL, source.latest.peakDbR) : null;
    },
    masterLufs: () => bridge.value?.latest.momentaryLufs ?? null,
    positionPpq: () => positionPpq.value,
    setTempoSegments: (segments: { startPpq: number; bpm: number }[]) => setTempoSegments(segments),
    setLoopRange: (startPpq: number, endPpq: number, enabled: boolean) =>
      transport.setLoop(startPpq, endPpq, enabled),
    setAutomationLanePoints: (
      target: AutomationTarget,
      param: AutomationParam,
      points: AutomationPoint[],
    ) => setAutomationLanePoints(target, param, points),
    removeAutomationLane: (target: AutomationTarget, param: AutomationParam) =>
      removeAutomationLane(target, param),
    automationLanePoints: (target: AutomationTarget, param: AutomationParam) =>
      store.automationLanes.find((lane) => lane.target === target && lane.param === param)
        ?.points ?? [],
    stripAutomationMode: (target: AutomationTarget) => automationStripMode(target),
    setStripAutomationMode: (target: AutomationTarget, mode: AutomationStripMode) =>
      setAutomationStripMode(target, mode),
    automationLaneCount: () => handle.value?.engine.automationLaneCount() ?? 0,
    automationInstalledParamIds: () => ctx.automationSync()?.installedParamIds() ?? [],
    seekPpq: (ppq: number) => transport.seekPpq(ppq),
    addAudioTrack: (name?: string) => addAudioTrack(name !== undefined ? { name } : {}),
    removeTrack: (trackId: number) => removeTrack(trackId),
    armTrack: (trackId: number | null) => recording.arm(trackId),
    addGroupTrack: (name?: string) => addGroupTrack(name !== undefined ? { name } : {}),
    setTrackGroup: (trackId: number, groupId: number | null) => setTrackGroup(trackId, groupId),
    trackGroups: () => store.tracks.map((track) => track.groupId ?? null),
    addTrackInsert: (
      trackId: number,
      processor: string,
      params?: Record<string, number | boolean>,
    ) => addInsert(trackId, processor, params),
    removeTrackInsert: (trackId: number, index: number) => removeInsert(trackId, index),
    setInsertSidechain: (trackId: number, index: number, sourceTrackId: number | null) =>
      setInsertSidechain(trackId, index, sourceTrackId),
    setStripGainDb: (target: number | 'master', gainDb: number) => setStripGain(target, gainDb),
    removeClip: (clipId: number) => deleteClip(clipId),
    freezeTrack: (trackId: number) => freezeTrack(trackId),
    unfreezeTrack: (trackId: number) => unfreezeTrack(trackId),
    bounceTrackRange: (trackId: number, startPpq: number, endPpq: number) =>
      bounceTrackRange(trackId, startPpq, endPpq),
    trackFrozenStates: () => store.tracks.map((track) => track.frozen?.assetId ?? null),
    setClipWarp: (
      clipId: number,
      warp: { enabled: boolean; sourceBpm: number; anchors?: WarpAnchor[] } | null,
    ) => setClipWarp(clipId, warp),
    addClickClip: async (trackId: number, beats: number, sourceBpm: number, startPpq = 0) => {
      const sampleRate = handle.value?.ctx.sampleRate ?? 48000;
      const secondsPerBeat = 60 / sourceBpm;
      const frames = Math.round(beats * secondsPerBeat * sampleRate);
      const data = new Float32Array(frames);
      const burstFrames = Math.round(0.01 * sampleRate);
      for (let beat = 0; beat < beats; beat++) {
        const begin = Math.round(beat * secondsPerBeat * sampleRate);
        for (let i = 0; i < burstFrames && begin + i < frames; i++) {
          data[begin + i] = Math.sin((2 * Math.PI * 1000 * i) / sampleRate) * 0.9;
        }
      }
      const meta = await ingestAudioBuffer([data], sampleRate, `clicks-${sourceBpm}`, {
        analysis: null,
      });
      return addAudioClip({ trackId, assetId: meta.id, startPpq, name: 'Clicks' });
    },
    addToneClip: async (
      trackId: number,
      seconds: number,
      frequencyHz: number,
      amplitude: number,
      startPpq = 0,
    ) => {
      const sampleRate = handle.value?.ctx.sampleRate ?? 48000;
      const assetId = await ingestTone(sampleRate, seconds, frequencyHz, amplitude);
      return addAudioClip({ trackId, assetId, startPpq, name: `Tone ${frequencyHz}` });
    },
    clipTakesInfo: (trackId: number) =>
      store.clips
        .filter((clip) => clip.trackId === trackId && isAudioClip(clip))
        .map((clip) => ({
          clipId: clip.id,
          startPpq: clip.startPpq,
          lengthPpq: clip.lengthPpq,
          takeCount: clip.takes?.length ?? 0,
          segments: (clip.compSegments ?? []).map((segment) => ({ ...segment })),
        })),
    setClipTakes: (clipId: number, takes: { assetId: string; name: string }[], active?: number) =>
      setClipTakes(clipId, takes, active),
    setClipActiveTake: (clipId: number, takeIndex: number) => setClipActiveTake(clipId, takeIndex),
    setClipCompSegments: (clipId: number, segments: { startPpq: number; takeIndex: number }[]) =>
      setClipCompSegments(clipId, segments),
    flattenClipComp: (clipId: number) => flattenClipComp(clipId),
    ingestToneAsset: async (seconds: number, frequencyHz: number, amplitude: number) => {
      const sampleRate = handle.value?.ctx.sampleRate ?? 48000;
      return ingestTone(sampleRate, seconds, frequencyHz, amplitude);
    },
    addMixerBus: (name?: string) => addMixerBus(name !== undefined ? { name } : {}),
    removeMixerBus: (busId: string) => removeMixerBus(busId),
    setSend: (
      target: number | 'master',
      busId: string,
      send: { levelDb: number; enabled?: boolean } | null,
    ) => setSend(target, busId, send),
    renderProbe: async (preset: string) => {
      const sampleRate = handle.value?.ctx.sampleRate ?? 48000;
      const channels = await prerenderMidiClip(
        [{ note: 60, velocity: 100, startPpq: 0, durationPpq: 0.5 }],
        { sampleRate, preset },
      );
      let sum = 0;
      let count = 0;
      let hash = 0x811c9dc5;
      for (const channel of channels) {
        for (const sample of channel) {
          sum += Math.abs(sample);
          count += 1;
          const q = Math.max(-32768, Math.min(32767, Math.round(sample * 32767))) & 0xffff;
          hash = Math.imul(hash ^ (q & 0xff), 0x01000193);
          hash = Math.imul(hash ^ (q >> 8), 0x01000193);
        }
      }
      return {
        frames: channels[0]?.length ?? 0,
        peak: peakAmplitude(channels),
        mean: count > 0 ? sum / count : 0,
        hash: (hash >>> 0).toString(16),
      };
    },
  };
}

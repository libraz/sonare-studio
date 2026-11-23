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
import { apiCalls, resetApiCalls } from '@/lib/api-recorder';
import { peakDb } from '@/lib/db';
import { FNV1A_OFFSET_BASIS, FNV1A_PRIME, fnv1a32Bytes } from '@/lib/fnv1a';
import { clamp } from '@/lib/math';
import { loadAsset } from '@/persistence/assets';
import type { NoteArticulation } from '@/project/annotations';
import { ingestAudioBuffer } from '@/project/audio-import';
import type { AutomationParam, AutomationPoint, AutomationTarget } from '@/project/automation';
import {
  addAudioClip,
  addAudioTrack,
  addGroupTrack,
  addInsert,
  addMidiClip,
  addMixerBus,
  addNote,
  addTrack,
  deleteClip,
  mixerBusStripTarget,
  removeAutomationLane,
  removeInsert,
  removeMixerBus,
  removeTrack,
  setActiveClip,
  setAutomationLanePoints,
  setClipActiveTake,
  setClipCompSegments,
  setClipFades,
  setClipGain,
  setClipTakes,
  setClipWarp,
  setInsertEnabled,
  setInsertSidechain,
  setMixerBusChannelLayout,
  setMixerBusGain,
  setNoteAnnotation,
  setSend,
  setStripGain,
  setStripOutputBus,
  setTempoSegments,
  setTrackGroup,
} from '@/project/commands';
import { flattenClipComp } from '@/project/comp-flatten';
import { bounceTrackRange, freezeTrack, unfreezeTrack } from '@/project/freeze';
import type { InsertParamValue, MixerSidechainSource } from '@/project/mixer';
import type { ScheduledProjectClip } from '@/project/scheduling';
import { serializeProject } from '@/project/serialization';
import { clearLastMidiImportEvents, lastMidiImportEvents } from '@/project/smf-import';
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
  mixerLaneTrackIds: () => readonly number[];
  whenEngineSyncIdle: () => Promise<void>;
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
    activeNotes: () =>
      store.notes.map((note) => ({
        id: note.id,
        pitch: note.pitch,
        channel: note.channel,
        startPpq: note.startPpq,
        durationPpq: note.durationPpq,
      })),
    // Articulation marks of the active clip by editor note id.
    noteArticulations: () =>
      Object.fromEntries(
        Object.entries(store.scoreAnnotations[store.clipId] ?? {}).flatMap(([noteId, mark]) =>
          mark.articulation === undefined ? [] : [[noteId, mark.articulation]],
        ),
      ),
    // Notes at exact positions: the editor grid cannot place a swung onset.
    addNoteAt: (pitch: number, startPpq: number, durationPpq: number, velocity = 100) =>
      addNote({ pitch, startPpq, durationPpq, velocity }),
    annotateNote: (noteId: number, articulation: NoteArticulation) =>
      setNoteAnnotation(store.clipId, noteId, { articulation }),
    // Sample-level comparison of stem assets against their source clip's asset.
    stemSumStats: async (sourceClipId: number, stemClipIds: number[]) => {
      const pcm = async (clipId: number) => {
        const assetId = store.clips.find((clip) => clip.id === clipId)?.assetId;
        if (assetId === undefined) throw new Error(`clip ${clipId} has no asset`);
        return (await loadAsset(assetId)).channels;
      };
      const rmsOf = (channels: Float32Array[]) => {
        let sum = 0;
        let count = 0;
        for (const channel of channels) {
          for (const sample of channel) {
            sum += sample * sample;
            count += 1;
          }
        }
        return count > 0 ? Math.sqrt(sum / count) : 0;
      };
      const source = await pcm(sourceClipId);
      const stems = await Promise.all(stemClipIds.map(pcm));
      const frames = source[0]?.length ?? 0;
      const error = source.map((channel, ch) => {
        const diff = new Float32Array(frames);
        for (let i = 0; i < frames; i++) {
          let mixed = 0;
          for (const stem of stems) mixed += stem[ch]?.[i] ?? 0;
          diff[i] = channel[i] - mixed;
        }
        return diff;
      });
      return {
        frames,
        stemFrames: stems.map((stem) => stem[0]?.length ?? 0),
        sourceRms: rmsOf(source),
        stemRms: stems.map(rmsOf),
        errorRms: rmsOf(error),
      };
    },
    chordCount: () => store.chords.length,
    chordRanges: () =>
      store.chords.map((chord) => ({
        startPpq: chord.startPpq,
        endPpq: chord.endPpq,
        rootPc: chord.rootPc,
        quality: chord.quality,
      })),
    selectionCount: () => store.selection.size,
    initialized: () => store.initialized,
    engineStarted: () => handle.value !== null,
    trackCount: () => store.tracks.length,
    trackIds: () => store.tracks.map((track) => track.id),
    clipCount: () => store.clips.length,
    midiClipIds: () =>
      store.clips.filter((clip) => clipKind(clip) === 'midi').map((clip) => clip.id),
    clipKinds: () => store.clips.map((clip) => clipKind(clip)),
    audioClipCount: () => store.clips.filter((clip) => isAudioClip(clip)).length,
    // Placement, not just counts: the engine refuses two clips that overlap on
    // one track, so a placement that fails says nothing without the geometry.
    clipRanges: () =>
      store.clips.map((clip) => ({
        id: clip.id,
        trackId: clip.trackId,
        kind: clipKind(clip),
        startPpq: clip.startPpq,
        lengthPpq: clip.lengthPpq,
      })),
    clipSettings: (id: number) => {
      const clip = store.clips.find((entry) => entry.id === id);
      return clip
        ? {
            gain: clip.gain,
            fadeInPpq: clip.fadeInPpq,
            fadeOutPpq: clip.fadeOutPpq,
            warpEnabled: clip.warp?.enabled ?? false,
          }
        : null;
    },
    // Lane order as the mixer sync declared it; the engine facade exposes no
    // reader for the order it holds.
    laneOrder: () => ({ studio: [...ctx.mixerLaneTrackIds()] }),
    armedTrackId: () => recording.armedTrackId.value,
    recordingState: () => recording.state.value,
    isRecording: () => recording.isRecording.value,
    inputLevel: () => recording.inputLevel.value,
    // The recorder's own failure channel. It is separate from `lastError`,
    // which carries the shell's: a record attempt that declines never reaches
    // the shell, so without this a refusal looks like nothing happening.
    recordingError: () => recording.error.value,
    setInputMonitor: (enabled: boolean) => recording.setMonitor(enabled),
    projectName: () => store.projectName,
    projectDocument: () => serializeProject(),
    activeTrackId: () => store.activeTrackId,
    activeClipId: () => store.clipId,
    selectClip: (clipId: number) => setActiveClip(clipId),
    applyPending: () => applyPending.value,
    whenEngineSyncIdle: () => ctx.whenEngineSyncIdle(),
    whenInsertGainReductionPolled: () =>
      bridge.value?.whenInsertGainReductionPolled() ?? Promise.resolve(),
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
    addMasterInsert: (processor: string, params?: Record<string, InsertParamValue>) =>
      addInsert('master', processor, params),
    setMasterInsertEnabled: (index: number, enabled: boolean) =>
      setInsertEnabled('master', index, enabled),
    removeMasterInsert: (index: number) => removeInsert('master', index),
    masteringProcessors: () =>
      (store.mixer.masteringChain?.processors ?? []).map((slot) => slot.processor),
    lastDownload: () => ctx.lastDownload(),
    lastMidiImportEvents,
    apiCalls,
    resetApiCalls,
    clearLastMidiImportEvents,
    exportProbe: async (
      includeMasterChain = true,
      range?: { startPpq: number; endPpq: number },
      stems = false,
      windows = 0,
      busStems = false,
    ) => {
      const result = await renderMixdownInWorker(serializeProject(), {
        includeMasterChain,
        ...(range !== undefined ? { range } : {}),
        ...(stems ? { stems } : {}),
        ...(busStems ? { busStems } : {}),
      }).result;
      const wav = encodeWav(result.channels, result.sampleRate, { bitDepth: 16 });
      return {
        totalFrames: result.totalFrames,
        sampleRate: result.sampleRate,
        peakDb: result.report.peakDb,
        channelPeaksDb: result.channels.map((channel) => peakOf([channel])),
        windowPeaksDb:
          windows > 0
            ? Array.from({ length: windows }, (_, index) => {
                const from = Math.floor((index * result.totalFrames) / windows);
                const to = Math.floor(((index + 1) * result.totalFrames) / windows);
                return peakOf(result.channels.map((channel) => channel.subarray(from, to)));
              })
            : null,
        truePeakDbtp: result.report.truePeakDbtp ?? null,
        lufs: result.report.lufs ?? null,
        wavBytes: wav.length,
        riff: String.fromCharCode(wav[0], wav[1], wav[2], wav[3]),
        hash: fnv1a32Bytes(wav).toString(16),
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
    meterChannelPeaksDb: () => {
      const latest = bridge.value?.latest;
      return latest ? [latest.peakDbL, latest.peakDbR] : null;
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
    automationLaneCount: () => handle.value?.engine.automationLaneCount ?? 0,
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
      params?: Record<string, InsertParamValue>,
    ) => addInsert(trackId, processor, params),
    removeTrackInsert: (trackId: number, index: number) => removeInsert(trackId, index),
    setInsertSidechain: (
      target: number | 'master' | `bus:${string}`,
      index: number,
      source: number | MixerSidechainSource | null,
    ) => setInsertSidechain(target, index, source),
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
    setClipGain: (clipId: number, gain: number) => setClipGain(clipId, gain),
    setClipFades: (clipId: number, fadeInPpq: number, fadeOutPpq: number) =>
      setClipFades(clipId, fadeInPpq, fadeOutPpq),
    setClipActiveTake: (clipId: number, takeIndex: number) => setClipActiveTake(clipId, takeIndex),
    setClipCompSegments: (clipId: number, segments: { startPpq: number; takeIndex: number }[]) =>
      setClipCompSegments(clipId, segments),
    flattenClipComp: (clipId: number) => flattenClipComp(clipId),
    ingestToneAsset: async (seconds: number, frequencyHz: number, amplitude: number) => {
      const sampleRate = handle.value?.ctx.sampleRate ?? 48000;
      return ingestTone(sampleRate, seconds, frequencyHz, amplitude);
    },
    addMixerBus: (name?: string) => addMixerBus(name !== undefined ? { name } : {}),
    addBusInsert: (busId: string, processor: string, params?: Record<string, InsertParamValue>) =>
      addInsert(mixerBusStripTarget(busId), processor, params),
    removeBusInsert: (busId: string, index: number) =>
      removeInsert(mixerBusStripTarget(busId), index),
    setBusOutput: (busId: string, destination: string | null) =>
      setStripOutputBus(mixerBusStripTarget(busId), destination),
    setTrackOutput: (trackId: number, destination: string | null) =>
      setStripOutputBus(trackId, destination),
    setBusSend: (
      busId: string,
      destination: string,
      send: { levelDb: number; enabled?: boolean; timing?: 'preFader' | 'postFader' } | null,
    ) => setSend(mixerBusStripTarget(busId), destination, send),
    setBusGain: (busId: string, gainDb: number) => setMixerBusGain(busId, gainDb),
    setBusLayout: (busId: string, layout: 'mono' | 'stereo' | '5.1' | '7.1') =>
      setMixerBusChannelLayout(busId, layout),
    addMidiTestClip: (name = 'MIDI envelope', startPpq = 64) => {
      const trackId = addTrack({ kind: 'midi', name });
      const clipId = addMidiClip({ trackId, startPpq, lengthPpq: 4, name });
      setActiveClip(clipId);
      addNote({ pitch: 60, startPpq: 0, durationPpq: 4, velocity: 100 });
      return { trackId, clipId };
    },
    addNotedMidiClip: (
      name: string,
      startPpq: number,
      lengthPpq: number,
      notes: { pitch: number; startPpq: number; durationPpq: number; channel?: number }[],
    ) => {
      const trackId = addTrack({ kind: 'midi', name });
      const clipId = addMidiClip({ trackId, startPpq, lengthPpq, name });
      setActiveClip(clipId);
      for (const note of notes) addNote({ ...note, velocity: 100 });
      return { trackId, clipId };
    },
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
      let hash = FNV1A_OFFSET_BASIS;
      for (const channel of channels) {
        for (const sample of channel) {
          sum += Math.abs(sample);
          count += 1;
          const q = clamp(Math.round(sample * 32767), -32768, 32767) & 0xffff;
          hash = Math.imul(hash ^ (q & 0xff), FNV1A_PRIME);
          hash = Math.imul(hash ^ (q >> 8), FNV1A_PRIME);
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

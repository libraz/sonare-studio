import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineHandle } from '@/engine/engine';
import { createMixerSync, linearToDb, PFL_AUDITION_GAIN_DB } from '@/engine/mixer-sync';
import { createAssetClipPageBindingFactory } from '@/export/clip-page-binding';
import type { OfflineRenderEngine } from '@/export/engine-render';
import {
  offlineAutomationLimitations,
  renderProjectWithEngine,
  trimDecayedTail,
} from '@/export/engine-render';
import { buildMidiSchedules } from '@/export/engine-render-context';
import { MAX_RELEASE_TAIL_SECONDS } from '@/export/engine-render-types';
import { MixdownCancelledError } from '@/export/mixdown';
import type { LoadedAudioAsset } from '@/persistence/assets';
import {
  insertAutomationParam,
  instrumentAutomationParam,
  masteringAutomationParam,
} from '@/project/automation';
import type { InsertSlot } from '@/project/mixer';
import type { ProjectDocument } from '@/project/serialization';
import type { EditorTrack } from '@/project/types';
import { neutralMixDocument } from '@/ui/mixer/mix-assistant';

const resample = vi.hoisted(() =>
  vi.fn((samples: Float32Array, sourceRate: number, targetRate: number): Float32Array => {
    if (sourceRate === targetRate) return samples;
    const frames = Math.max(1, Math.round((samples.length * targetRate) / sourceRate));
    const out = new Float32Array(frames);
    if (frames === 1 || samples.length === 1) {
      out.fill(samples[0]);
      return out;
    }
    const step = (samples.length - 1) / (frames - 1);
    for (let index = 0; index < frames; index++) {
      const position = index * step;
      const sourceIndex = Math.floor(position);
      const fraction = position - sourceIndex;
      const next = Math.min(samples.length - 1, sourceIndex + 1);
      out[index] = samples[sourceIndex] + (samples[next] - samples[sourceIndex]) * fraction;
    }
    return out;
  }),
);

vi.mock('@/lib/wasm', () => ({
  ensureWasm: async () => ({ resample }),
}));

beforeEach(() => {
  resample.mockClear();
});

/** Records every engine call and renders a constant sample value. */
class FakeEngine implements OfflineRenderEngine {
  calls: Array<[string, ...unknown[]]> = [];
  destroyed = false;
  /** Sample value process() writes into every frame. */
  fill = 0.25;
  /** Value tailSamples() reports. */
  tail = 0;

  private record(name: string, ...args: unknown[]): void {
    this.calls.push([name, ...args]);
  }
  named(name: string): Array<[string, ...unknown[]]> {
    return this.calls.filter(([n]) => n === name);
  }

  private declaredTrackIds: number[] = [];
  private declaredBusIds = new Set<number>();

  setTrackLanes(lanes: unknown): void {
    this.record('setTrackLanes', lanes);
    this.declaredTrackIds = (lanes as Array<number | { trackId: number }>).map((lane) =>
      typeof lane === 'number' ? lane : lane.trackId,
    );
  }
  setTrackBuses(buses: unknown): void {
    this.record('setTrackBuses', buses);
    this.declaredBusIds = new Set((buses as Array<{ busId: number }>).map((bus) => bus.busId));
  }
  /** Stub ids keep the packed lane-position shape so tests can decode them. */
  resolveTrackLaneAutomationId(trackId: number, paramName: 'faderDb' | 'pan'): number {
    const laneIndex = this.declaredTrackIds.indexOf(trackId);
    if (laneIndex < 0) return -1;
    const kind = paramName === 'pan' ? ENGINE_MIXER_PARAM_PAN : ENGINE_MIXER_PARAM_FADER_DB;
    return ENGINE_MIXER_TARGET_BASE | (laneIndex << 8) | kind;
  }
  resolveBusAutomationId(busId: number, _paramName: 'faderDb'): number {
    if (!this.declaredBusIds.has(busId)) return -1;
    return ENGINE_MIXER_TARGET_BASE | ((254 - busId) << 8) | ENGINE_MIXER_PARAM_FADER_DB;
  }
  resolveMasterAutomationId(paramName: 'faderDb' | 'pan' | 'width'): number {
    if (paramName === 'width') return -1;
    const kind = paramName === 'pan' ? ENGINE_MIXER_PARAM_PAN : ENGINE_MIXER_PARAM_FADER_DB;
    return ENGINE_MIXER_TARGET_BASE | (ENGINE_MIXER_LANE_MASTER << 8) | kind;
  }
  setTrackStripJson(trackId: number, json: string): void {
    this.record('setTrackStripJson', trackId, json);
  }
  setMasterStripJson(json: string): void {
    this.record('setMasterStripJson', json);
  }
  setBusStripJson(busId: number, json: string): void {
    this.record('setBusStripJson', busId, json);
  }
  setLaneSidechain(trackId: number, insertIndex: number, sourceTrackId: number): void {
    this.record('setLaneSidechain', trackId, insertIndex, sourceTrackId);
  }
  setBusSidechain(busId: number, insertIndex: number, sourceKind: number, sourceId: number): void {
    this.record('setBusSidechain', busId, insertIndex, sourceKind, sourceId);
  }
  setMasterSidechain(insertIndex: number, sourceKind: number, sourceId: number): void {
    this.record('setMasterSidechain', insertIndex, sourceKind, sourceId);
  }
  setTrackStripInsertBypassed(trackId: number, index: number, bypassed: boolean): void {
    this.record('setTrackStripInsertBypassed', trackId, index, bypassed);
  }
  setMasterStripInsertBypassed(index: number, bypassed: boolean): void {
    this.record('setMasterStripInsertBypassed', index, bypassed);
  }
  setTrackStripEqBandJson(trackId: number, bandIndex: number, json: string): void {
    this.record('setTrackStripEqBandJson', trackId, bandIndex, json);
  }
  setMasterStripEqBandJson(bandIndex: number, json: string): void {
    this.record('setMasterStripEqBandJson', bandIndex, json);
  }
  setSoloMute(laneIndex: number, solo: boolean, mute: boolean): void {
    this.record('setSoloMute', laneIndex, solo, mute);
  }
  setTrackStripPanLaw(trackId: number, panLaw: unknown): void {
    this.record('setTrackStripPanLaw', trackId, panLaw);
  }
  setTrackStripPanMode(trackId: number, panMode: unknown): void {
    this.record('setTrackStripPanMode', trackId, panMode);
  }
  setTrackStripDualPan(trackId: number, leftPan: number, rightPan: number): void {
    this.record('setTrackStripDualPan', trackId, leftPan, rightPan);
  }
  setTrackStripChannelDelaySamples(trackId: number, delaySamples: number): void {
    this.record('setTrackStripChannelDelaySamples', trackId, delaySamples);
  }
  setParameter(paramId: number, value: number): void {
    this.record('setParameter', paramId, value);
  }
  setAutomationLane(paramId: number, points: unknown): void {
    this.record('setAutomationLane', paramId, points);
  }
  resolveTrackInsertAutomationId(trackId: number, insertIndex: number, paramName: string): number {
    this.record('resolveTrackInsertAutomationId', trackId, insertIndex, paramName);
    return paramName === 'unknown' ? -1 : (0xe0000000 | (trackId << 16) | (insertIndex << 8)) >>> 0;
  }
  resolveMasterInsertAutomationId(insertIndex: number, paramName: string): number {
    this.record('resolveMasterInsertAutomationId', insertIndex, paramName);
    return paramName === 'unknown' ? -1 : (0xe1ff0000 | (insertIndex << 8)) >>> 0;
  }
  resolveBusInsertAutomationId(busId: number, insertIndex: number, paramName: string): number {
    this.record('resolveBusInsertAutomationId', busId, insertIndex, paramName);
    return paramName === 'unknown' ? -1 : (0xe1fe0000 | (busId << 8) | insertIndex) >>> 0;
  }
  resolveInstrumentAutomationId(destinationId: number, paramName: string): number {
    this.record('resolveInstrumentAutomationId', destinationId, paramName);
    return paramName === 'unknown' ? -1 : (0xc0000000 | (destinationId << 8)) >>> 0;
  }
  setTempoSegments(segments: unknown): void {
    this.record('setTempoSegments', segments);
  }
  setClips(clips: unknown): void {
    this.record('setClips', clips);
  }
  setWarpVoiceCapacity(voices: number): void {
    this.record('setWarpVoiceCapacity', voices);
  }
  warpStretchOverflowCount(): number {
    return 0;
  }
  tailSamples(): number {
    return this.tail;
  }
  setMidiClips(clips: unknown): void {
    this.record('setMidiClips', clips);
  }
  setSynthInstrument(patch?: object | string, destinationId?: number): void {
    this.record('setSynthInstrument', patch, destinationId);
  }
  loadSoundFont(data: Uint8Array): void {
    this.record('loadSoundFont', data);
  }
  setSf2Instrument(config?: object, destinationId?: number): void {
    this.record('setSf2Instrument', config, destinationId);
  }
  pushMidiSysex(destinationId: number, data: Uint8Array, renderFrame = -1): void {
    this.record('pushMidiSysex', destinationId, data, renderFrame);
  }
  seekSample(sample: number): void {
    this.record('seekSample', sample);
  }
  settleParameters(): void {
    this.record('settleParameters');
  }
  play(): void {
    this.record('play');
  }
  stop(): void {
    this.record('stop');
  }
  process(channels: Float32Array[]): Float32Array[] {
    this.record('process', channels[0].length);
    for (const channel of channels) channel.fill(this.fill);
    return channels;
  }
  destroy(): void {
    this.destroyed = true;
  }
}

/** Fake engine exposing the newer bus-insert bypass ABI. */
class BusBypassFakeEngine extends FakeEngine {
  setBusStripInsertBypassed(busId: number, index: number, bypassed: boolean): void {
    this.calls.push(['setBusStripInsertBypassed', busId, index, bypassed]);
  }
}

class FakeEngineWithBusEq extends FakeEngine {
  setBusStripEqBandJson(busId: number, bandIndex: number, json: string): void {
    this.calls.push(['setBusStripEqBandJson', busId, bandIndex, json]);
  }
}

const SAMPLES_PER_PPQ = 24000;
const MASTER_FADER_PARAM_ID = 0x4d58ff01;
const ENGINE_MIXER_TARGET_BASE = 0x4d580000;
const ENGINE_MIXER_PARAM_FADER_DB = 1;
const ENGINE_MIXER_PARAM_PAN = 2;
const ENGINE_MIXER_LANE_MASTER = 0xff;
const BUS_1_FADER_PARAM_ID = 0x4d58fd01;

/** Decodes the status nibble from a packed MIDI 1.0 UMP channel-voice word. */
function midiStatus(word0: number): number {
  return (word0 >>> 20) & 0xf;
}

/** Decodes the note number from a packed MIDI 1.0 UMP channel-voice word. */
function midiNote(word0: number): number {
  return (word0 >>> 8) & 0x7f;
}

/** Decodes the velocity/data1 byte from a packed MIDI 1.0 UMP channel-voice word. */
function midiData1(word0: number): number {
  return word0 & 0x7f;
}

/**
 * Fake renderer that turns scheduled content into deterministic audio, so
 * tests assert the audible contract rather than only the command stream.
 */
class AudibilityEngine extends FakeEngine {
  private cursor = 0;
  private playing = false;
  private tempoSegments: Array<{ startPpq: number; bpm: number; endBpm?: number }> = [
    { startPpq: 0, bpm: 120 },
  ];
  private laneIds: number[] = [];
  private laneSoloMute = new Map<number, { solo: boolean; mute: boolean }>();
  private laneGainByIndex = new Map<number, number>();
  private laneGainAutomation = new Map<number, Array<{ sample: number; value: number }>>();
  private lanePanByIndex = new Map<number, number>();
  private lanePanLawByTrack = new Map<number, string>();
  private lanePanModeByTrack = new Map<number, string>();
  private laneDualPanByTrack = new Map<number, { left: number; right: number }>();
  private laneDelayByTrack = new Map<number, number>();
  private masterGain = 1;
  private masterGainAutomation: Array<{ sample: number; value: number }> = [];
  protected audioClips: Array<{
    trackId: number;
    channels: Float32Array[];
    pageProvider?: unknown;
    startSample: number;
    lengthSamples: number;
    gain: number;
    fadeInSamples: number;
    fadeOutSamples: number;
    warpAnchors?: Array<{ warpSample: number; sourceSample: number }>;
  }> = [];
  private midiNotes: Array<{
    trackId: number;
    startFrame: number;
    endFrame: number;
    velocity: number;
    clipStart: number;
    clipLength: number;
    clipGain: number;
    fadeInSamples: number;
    fadeOutSamples: number;
  }> = [];

  setTrackLanes(lanes: Array<number | { trackId: number }>): void {
    super.setTrackLanes(lanes);
    this.laneIds = lanes.map((lane) => (typeof lane === 'number' ? lane : lane.trackId));
  }

  setSoloMute(laneIndex: number, solo: boolean, mute: boolean): void {
    super.setSoloMute(laneIndex, solo, mute);
    this.laneSoloMute.set(laneIndex, { solo, mute });
  }

  setParameter(paramId: number, value: number): void {
    super.setParameter(paramId, value);
    if (paramId === MASTER_FADER_PARAM_ID) this.masterGain = 10 ** (value / 20);
    if ((paramId & 0xffff0000) !== ENGINE_MIXER_TARGET_BASE) return;
    const laneIndex = (paramId >>> 8) & 0xff;
    const kind = paramId & 0xff;
    if (laneIndex !== ENGINE_MIXER_LANE_MASTER && kind === ENGINE_MIXER_PARAM_FADER_DB) {
      this.laneGainByIndex.set(laneIndex, 10 ** (value / 20));
    }
    if (laneIndex !== ENGINE_MIXER_LANE_MASTER && kind === ENGINE_MIXER_PARAM_PAN) {
      this.lanePanByIndex.set(laneIndex, value);
    }
  }

  setTrackStripPanLaw(trackId: number, panLaw: string): void {
    super.setTrackStripPanLaw(trackId, panLaw);
    this.lanePanLawByTrack.set(trackId, panLaw);
  }

  setTrackStripPanMode(trackId: number, panMode: string): void {
    super.setTrackStripPanMode(trackId, panMode);
    this.lanePanModeByTrack.set(trackId, panMode);
  }

  setTrackStripDualPan(trackId: number, left: number, right: number): void {
    super.setTrackStripDualPan(trackId, left, right);
    this.laneDualPanByTrack.set(trackId, { left, right });
  }

  setTrackStripChannelDelaySamples(trackId: number, delaySamples: number): void {
    super.setTrackStripChannelDelaySamples(trackId, delaySamples);
    this.laneDelayByTrack.set(trackId, delaySamples);
  }

  private ppqToSample(ppq: number): number {
    const segments = [...this.tempoSegments].sort((a, b) => a.startPpq - b.startPpq);
    let samples = 0;
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      const nextStart = segments[i + 1]?.startPpq ?? Number.POSITIVE_INFINITY;
      if (ppq <= segment.startPpq) break;
      const end = Math.min(ppq, nextStart);
      samples += ((end - segment.startPpq) * 60 * 48000) / segment.bpm;
      if (ppq < nextStart) break;
    }
    return Math.round(samples);
  }

  setTempoSegments(segments: Array<{ startPpq: number; bpm: number; endBpm?: number }>): void {
    super.setTempoSegments(segments);
    this.tempoSegments = segments.length > 0 ? segments : [{ startPpq: 0, bpm: 120 }];
  }

  setAutomationLane(paramId: number, points: Array<{ ppq: number; value: number }>): void {
    super.setAutomationLane(paramId, points);
    const automation = points
      .map((point) => ({ sample: this.ppqToSample(point.ppq), value: 10 ** (point.value / 20) }))
      .sort((a, b) => a.sample - b.sample);
    if (paramId === MASTER_FADER_PARAM_ID) {
      this.masterGainAutomation = automation;
      return;
    }
    if ((paramId & 0xffff0000) !== ENGINE_MIXER_TARGET_BASE) return;
    const laneIndex = (paramId >>> 8) & 0xff;
    const kind = paramId & 0xff;
    if (laneIndex !== ENGINE_MIXER_LANE_MASTER && kind === ENGINE_MIXER_PARAM_FADER_DB) {
      this.laneGainAutomation.set(laneIndex, automation);
    }
  }

  setClips(
    clips: Array<{
      trackId: number;
      channels?: Float32Array[];
      pageProvider?: unknown;
      startPpq: number;
      lengthSamples: number;
      gain?: number;
      fadeInSamples?: number;
      fadeOutSamples?: number;
      warpMode?: string;
      warpAnchors?: Array<{ warpSample: number; sourceSample: number }>;
    }>,
  ): void {
    super.setClips(clips);
    this.audioClips = clips.map((clip) => ({
      trackId: clip.trackId,
      channels: clip.channels ?? [],
      ...(clip.pageProvider !== undefined ? { pageProvider: clip.pageProvider } : {}),
      startSample: this.ppqToSample(clip.startPpq),
      lengthSamples: clip.lengthSamples,
      gain: clip.gain ?? 1,
      fadeInSamples: clip.fadeInSamples ?? 0,
      fadeOutSamples: clip.fadeOutSamples ?? 0,
      ...(clip.warpMode === 'time-stretch' && clip.warpAnchors
        ? { warpAnchors: clip.warpAnchors }
        : {}),
    }));
  }

  /** The source frame a clip frame reads: warp anchors interpolated linearly. */
  private clipSourceFrame(
    clip: (typeof AudibilityEngine.prototype.audioClips)[number],
    clipFrame: number,
  ): number {
    const anchors = clip.warpAnchors;
    if (!anchors) return clipFrame;
    for (let i = 0; i + 1 < anchors.length; i += 1) {
      const [a, b] = [anchors[i], anchors[i + 1]];
      if (clipFrame >= a.warpSample && clipFrame < b.warpSample) {
        const t = (clipFrame - a.warpSample) / (b.warpSample - a.warpSample);
        return Math.floor(a.sourceSample + t * (b.sourceSample - a.sourceSample));
      }
    }
    return anchors[anchors.length - 1].sourceSample;
  }

  /** The clip's fade multiplier at a clip frame (engine ramps: i/n). */
  private clipFade(
    clip: (typeof AudibilityEngine.prototype.audioClips)[number],
    clipFrame: number,
  ): number {
    let gain = 1;
    if (clipFrame < clip.fadeInSamples) gain *= clipFrame / clip.fadeInSamples;
    const fromEnd = clip.lengthSamples - 1 - clipFrame;
    if (fromEnd < clip.fadeOutSamples) gain *= fromEnd / clip.fadeOutSamples;
    return gain;
  }

  /**
   * One clip sample. A clip scheduled without channels stands for a source the
   * fake does not model and reads as unity; a page-backed clip overrides this.
   */
  protected clipSample(
    clip: (typeof AudibilityEngine.prototype.audioClips)[number],
    channelIndex: number,
    clipFrame: number,
    fallback: number,
  ): number {
    return (clip.channels[channelIndex] ?? clip.channels[0])?.[clipFrame] ?? fallback;
  }

  setMidiClips(
    clips: Array<{
      destinationId: number;
      startSample?: number;
      lengthSamples?: number;
      gain?: number;
      fadeInSamples?: number;
      fadeOutSamples?: number;
      loop?: boolean;
      loopLengthSamples?: number;
      events: Array<{ renderFrame: number; word0: number }>;
    }>,
  ): void {
    super.setMidiClips(clips);
    this.midiNotes = [];
    for (const clip of clips) {
      const active = new Map<number, Array<{ startFrame: number; velocity: number }>>();
      const notes: Array<{
        trackId: number;
        startFrame: number;
        endFrame: number;
        velocity: number;
        clipStart: number;
        clipLength: number;
        clipGain: number;
        fadeInSamples: number;
        fadeOutSamples: number;
      }> = [];
      for (const event of clip.events) {
        const status = midiStatus(event.word0);
        const note = midiNote(event.word0);
        const velocity = midiData1(event.word0);
        if (status === 0x9 && velocity > 0) {
          active.set(note, [
            ...(active.get(note) ?? []),
            { startFrame: event.renderFrame, velocity },
          ]);
          continue;
        }
        if (status !== 0x8 && status !== 0x9) continue;
        const starts = active.get(note);
        const start = starts?.shift();
        if (start === undefined || event.renderFrame <= start.startFrame) continue;
        notes.push({
          trackId: clip.destinationId,
          startFrame: start.startFrame,
          endFrame: event.renderFrame,
          velocity: start.velocity,
          clipStart: clip.startSample ?? 0,
          clipLength: clip.lengthSamples ?? Number.POSITIVE_INFINITY,
          clipGain: clip.gain ?? 1,
          fadeInSamples: clip.fadeInSamples ?? 0,
          fadeOutSamples: clip.fadeOutSamples ?? 0,
        });
      }
      if (
        clip.loop !== true ||
        clip.loopLengthSamples === undefined ||
        clip.lengthSamples === undefined
      ) {
        this.midiNotes.push(...notes);
        continue;
      }
      const startSample = clip.startSample ?? 0;
      const endSample = startSample + clip.lengthSamples;
      for (const note of notes) {
        for (
          let loopStart = startSample;
          loopStart < endSample;
          loopStart += clip.loopLengthSamples
        ) {
          const shift = loopStart - startSample;
          const startFrame = note.startFrame + shift;
          if (startFrame >= endSample) break;
          this.midiNotes.push({
            ...note,
            startFrame,
            endFrame: Math.min(note.endFrame + shift, endSample),
          });
        }
      }
    }
  }

  seekSample(sample: number): void {
    super.seekSample(sample);
    this.cursor = sample;
  }

  play(): void {
    super.play();
    this.playing = true;
  }

  stop(): void {
    super.stop();
    this.playing = false;
  }

  protected midiSample(_trackId: number, velocity: number): number {
    return velocity / 127;
  }

  process(channels: Float32Array[]): Float32Array[] {
    if (!this.playing) return channels;
    const anySolo = [...this.laneSoloMute.values()].some((state) => state.solo);
    const audibleTrackIds = new Set(
      this.laneIds.filter((trackId, laneIndex) => {
        const state = this.laneSoloMute.get(laneIndex) ?? { solo: false, mute: false };
        return !state.mute && (!anySolo || state.solo) && trackId !== undefined;
      }),
    );
    const laneGainForTrack = (trackId: number, frame: number): number => {
      const laneIndex = this.laneIds.indexOf(trackId);
      const automated = [...(this.laneGainAutomation.get(laneIndex) ?? [])]
        .reverse()
        .find((point) => frame >= point.sample)?.value;
      return automated ?? this.laneGainByIndex.get(laneIndex) ?? 1;
    };
    const stereoForTrack = (trackId: number, left: number, right: number): [number, number] => {
      const laneIndex = this.laneIds.indexOf(trackId);
      const pan = this.lanePanByIndex.get(laneIndex) ?? 0;
      const mode = this.lanePanModeByTrack.get(trackId) ?? 'balance';
      const dual = this.laneDualPanByTrack.get(trackId);
      if (mode === 'dualPan' && dual) {
        return [
          left * (dual.left > 0 ? 1 - dual.left : 1),
          right * (dual.right < 0 ? 1 + dual.right : 1),
        ];
      }
      if (pan === 0) return [left, right];
      // The fake needs a deterministic audible pan model, not a DSP-perfect
      // implementation. Its neutral position remains unity to keep the rest
      // of this suite focused on routing and scheduling.
      const leftGain = pan > 0 ? 1 - pan : 1;
      const rightGain = pan < 0 ? 1 + pan : 1;
      return [left * leftGain, right * rightGain];
    };
    for (let frameOffset = 0; frameOffset < channels[0].length; frameOffset++) {
      const frame = this.cursor + frameOffset;
      const masterGain =
        [...this.masterGainAutomation].reverse().find((point) => frame >= point.sample)?.value ??
        this.masterGain;
      let leftSample = 0;
      let rightSample = 0;
      for (const clip of this.audioClips) {
        if (!audibleTrackIds.has(clip.trackId)) continue;
        const sourceFrame = frame - (this.laneDelayByTrack.get(clip.trackId) ?? 0);
        if (
          sourceFrame >= clip.startSample &&
          sourceFrame < clip.startSample + clip.lengthSamples
        ) {
          const clipFrame = sourceFrame - clip.startSample;
          const laneGain = laneGainForTrack(clip.trackId, sourceFrame);
          const readFrame = this.clipSourceFrame(clip, clipFrame);
          const fade = this.clipFade(clip, clipFrame);
          const left = this.clipSample(clip, 0, readFrame, 1);
          const right = this.clipSample(clip, 1, readFrame, left);
          const panned = stereoForTrack(
            clip.trackId,
            left * clip.gain * laneGain * fade,
            right * clip.gain * laneGain * fade,
          );
          leftSample += panned[0];
          rightSample += panned[1];
        }
      }
      for (const note of this.midiNotes) {
        if (!audibleTrackIds.has(note.trackId)) continue;
        const sourceFrame = frame - (this.laneDelayByTrack.get(note.trackId) ?? 0);
        if (sourceFrame >= note.startFrame && sourceFrame < note.endFrame) {
          const clipFrame = sourceFrame - note.clipStart;
          const fadeIn = note.fadeInSamples > 0 ? Math.min(1, clipFrame / note.fadeInSamples) : 1;
          const fadeOut =
            note.fadeOutSamples > 0 && Number.isFinite(note.clipLength)
              ? Math.min(1, (note.clipLength - clipFrame) / note.fadeOutSamples)
              : 1;
          const value =
            this.midiSample(note.trackId, note.velocity) *
            laneGainForTrack(note.trackId, sourceFrame) *
            note.clipGain *
            fadeIn *
            fadeOut;
          const panned = stereoForTrack(note.trackId, value, value);
          leftSample += panned[0];
          rightSample += panned[1];
        }
      }
      channels[0][frameOffset] = leftSample * masterGain;
      (channels[1] ?? channels[0])[frameOffset] = rightSample * masterGain;
    }
    this.cursor += channels[0].length;
    return channels;
  }
}

/** Audible fake whose loaded SF2 byte selects a deterministic timbre gain. */
class SoundFontAudibilityEngine extends AudibilityEngine {
  private loadedSoundFontGain = 1;
  private readonly soundFontGainByTrack = new Map<number, number>();

  loadSoundFont(data: Uint8Array): void {
    super.loadSoundFont(data);
    this.loadedSoundFontGain = (data[0] ?? 100) / 100;
  }

  setSf2Instrument(config?: object, destinationId?: number): void {
    super.setSf2Instrument(config, destinationId);
    if (destinationId !== undefined) {
      this.soundFontGainByTrack.set(destinationId, this.loadedSoundFontGain);
    }
  }

  protected midiSample(trackId: number, velocity: number): number {
    return (velocity / 127) * (this.soundFontGainByTrack.get(trackId) ?? 1);
  }
}

/** Minimal valid document: one MIDI track and one audio track + a send bus. */
function makeDoc(): ProjectDocument {
  return {
    schemaVersion: 3,
    name: 'engine-render-test',
    sampleRate: 48000,
    tempoSegments: [{ startPpq: 0, bpm: 120 }],
    timeSignatures: [],
    markers: [],
    sections: [],
    mixer: {
      master: { gainDb: -3, pan: 0.5, inserts: [], sends: [] },
      buses: [{ id: 'bus-a', name: 'A', gainDb: -6 }],
    },
    tracks: [
      {
        name: 'Keys',
        color: '#fff',
        kind: 'midi',
        mute: false,
        solo: false,
        volume: 0.5,
        pan: 0,
        clips: [
          {
            name: 'phrase',
            startPpq: 0,
            lengthPpq: 4,
            sourceOffsetPpq: 0,
            gain: 1,
            loopEnabled: false,
            loopLengthPpq: 0,
            notes: [{ pitch: 60, velocity: 96, startPpq: 0, durationPpq: 1, channel: 0 }],
          },
        ],
        automation: [
          {
            param: 'faderDb',
            enabled: true,
            points: [
              { ppq: 0, value: -24 },
              { ppq: 4, value: 0, curve: 'hold' },
            ],
          },
        ],
      },
      {
        name: 'Drums',
        color: '#000',
        kind: 'audio',
        mute: false,
        solo: false,
        volume: 1,
        pan: 0,
        mixer: {
          gainDb: 2,
          pan: -0.25,
          inserts: [],
          sends: [{ busId: 'bus-a', levelDb: -9, enabled: true }],
        },
        clips: [
          {
            name: 'loop',
            kind: 'audio',
            assetId: 'asset-1',
            startPpq: 2,
            lengthPpq: 2,
            sourceOffsetPpq: 0,
            gain: 0.8,
            loopEnabled: false,
            loopLengthPpq: 0,
            notes: [],
          },
        ],
      },
    ],
    masterAutomation: [
      { param: 'pan', enabled: true, points: [{ ppq: 1, value: -1 }] },
      { param: 'faderDb', enabled: false, points: [{ ppq: 0, value: -60 }] },
    ],
  } as unknown as ProjectDocument;
}

/** Fake OPFS asset: one second of stereo at the render rate. */
function fakeAsset(): LoadedAudioAsset {
  const frames = 48000;
  return {
    meta: { id: 'asset-1', name: 'loop.wav', sampleRate: 48000, numChannels: 2, numFrames: frames },
    channels: [new Float32Array(frames).fill(0.5), new Float32Array(frames).fill(0.5)],
  };
}

/** Expected UMP MIDI 1.0 channel-voice word for a note-on. */
function noteOnWord(channel: number, pitch: number, velocity: number): number {
  return (0x2 << 28) | (0x9 << 20) | (channel << 16) | (pitch << 8) | velocity;
}

/** Expected UMP MIDI 1.0 channel-voice word for a note-off. */
function noteOffWord(channel: number, pitch: number, velocity = 0): number {
  return (0x2 << 28) | (0x8 << 20) | (channel << 16) | (pitch << 8) | velocity;
}

/** Expected UMP MIDI 1.0 channel-voice word for a control change. */
function ccWord(channel: number, controller: number, value: number): number {
  return (0x2 << 28) | (0xb << 20) | (channel << 16) | (controller << 8) | value;
}

/** Expected UMP MIDI 1.0 channel-voice word for channel pressure. */
function channelPressureWord(channel: number, value: number): number {
  return (0x2 << 28) | (0xd << 20) | (channel << 16) | (value << 8);
}

/** Expected UMP MIDI 1.0 channel-voice word for polyphonic key pressure. */
function polyPressureWord(channel: number, pitch: number, value: number): number {
  return (0x2 << 28) | (0xa << 20) | (channel << 16) | (pitch << 8) | value;
}

/** Expected UMP MIDI 1.0 channel-voice word for pitch bend. */
function pitchBendWord(channel: number, value: number): number {
  return (0x2 << 28) | (0xe << 20) | (channel << 16) | ((value & 0x7f) << 8) | (value >> 7);
}

/** Expected UMP MIDI 1.0 channel-voice word for a program change. */
function pcWord(channel: number, program: number): number {
  return (0x2 << 28) | (0xc << 20) | (channel << 16) | (program << 8);
}

function renderOptions(engine: FakeEngine) {
  return {
    deps: null,
    createEngine: () => engine,
    loadAudioAsset: async () => fakeAsset(),
  };
}

function midiAmplitude(velocity: number): number {
  return velocity / 127;
}

function dbGain(db: number): number {
  return 10 ** (db / 20);
}

function defaultMasterGain(): number {
  return dbGain(-3);
}

function defaultMidiLaneGain(): number {
  // Enabled fader lanes are absolute fader dB values; they replace, rather
  // than offset, the track's manual volume/trim setting.
  return dbGain(-24);
}

function defaultAudioLaneGain(): number {
  return dbGain(2);
}

function defaultMidiLevel(velocity: number, masterGain = defaultMasterGain()): number {
  return midiAmplitude(velocity) * defaultMidiLaneGain() * masterGain;
}

function defaultAudioLevel(
  sample: number,
  clipGain = 0.8,
  masterGain = defaultMasterGain(),
): number {
  return sample * clipGain * defaultAudioLaneGain() * masterGain;
}

describe('renderProjectWithEngine', () => {
  it('rejects a surround master layout before producing a misleading stereo export', async () => {
    const doc = makeDoc();
    doc.mixer!.masterLayout = '5.1';
    await expect(renderProjectWithEngine(doc, renderOptions(new FakeEngine()))).rejects.toThrow(
      /Surround master export is unavailable/,
    );
  });
  it('assigns collision-free synthetic ids beyond 10,000 MIDI clips per track', () => {
    const doc = makeDoc();
    const source = doc.tracks[0].clips[0];
    doc.tracks[0].clips = Array.from({ length: 10_001 }, (_, index) => ({
      ...source,
      name: `Track one ${index}`,
      notes: index === 10_000 ? source.notes : [],
    }));
    doc.tracks[1] = {
      ...doc.tracks[0],
      name: 'Track two',
      clips: [{ ...source, name: 'Track two note' }],
    };

    const schedules = buildMidiSchedules(doc, [1, 2], doc.tempoSegments, doc.sampleRate);

    expect(schedules.map((schedule) => schedule.id)).toEqual([10_001, 10_002]);
  });

  it('renders audible MIDI notes and audio clips through the master fader', async () => {
    const engine = new AudibilityEngine();
    const result = await renderProjectWithEngine(makeDoc(), renderOptions(engine));
    const masterGain = 10 ** (-3 / 20);

    // The MIDI note starts at the timeline head on track 1.
    expect(result.channels[0][0]).toBeCloseTo(defaultMidiLevel(96, masterGain), 5);
    // Between the one-PPQ MIDI note and the audio clip there is silence.
    expect(result.channels[0][30000]).toBeCloseTo(0, 5);
    // The audio clip starts at PPQ 2 on track 2 and carries its clip gain.
    expect(result.channels[0][2 * SAMPLES_PER_PPQ]).toBeCloseTo(
      defaultAudioLevel(0.5, 0.8, masterGain),
      5,
    );
  });

  it('stops MIDI notes audibly at note-off and starts the next note cleanly', async () => {
    const doc = makeDoc();
    doc.tracks[1].mute = true;
    doc.tracks[0].clips[0].notes = [
      { pitch: 60, velocity: 96, startPpq: 0, durationPpq: 1, channel: 0 },
      { pitch: 64, velocity: 96, startPpq: 1, durationPpq: 1, channel: 0 },
    ];

    const result = await renderProjectWithEngine(doc, renderOptions(new AudibilityEngine()));
    const masterGain = 10 ** (-3 / 20);

    expect(result.channels[0][0]).toBeCloseTo(defaultMidiLevel(96, masterGain), 5);
    expect(result.channels[0][SAMPLES_PER_PPQ - 2]).toBeCloseTo(
      defaultMidiLevel(96, masterGain),
      5,
    );
    // note-offs are scheduled one sample before the nominal end and are
    // exclusive in this audible fake, so the boundary frame is silent.
    expect(result.channels[0][SAMPLES_PER_PPQ - 1]).toBeCloseTo(0, 5);
    expect(result.channels[0][SAMPLES_PER_PPQ]).toBeCloseTo(defaultMidiLevel(96, masterGain), 5);
    expect(result.channels[0][2 * SAMPLES_PER_PPQ - 1]).toBeCloseTo(0, 5);
  });

  it('renders MIDI note velocity and clip gain as audible level', async () => {
    const doc = makeDoc();
    doc.tracks[1].mute = true;
    doc.tracks[0].clips[0].gain = 0.5;
    doc.tracks[0].clips[0].notes = [
      { pitch: 60, velocity: 100, startPpq: 0, durationPpq: 1, channel: 0 },
    ];

    const result = await renderProjectWithEngine(doc, renderOptions(new AudibilityEngine()));

    // The instrument sees velocity 100; the engine multiplies its rendered
    // audio by the clip's linear gain 0.5.
    expect(result.channels[0][0]).toBeCloseTo(defaultMidiLevel(50), 5);
  });

  it('removes non-selected pre-fader sends from isolated stem lanes', async () => {
    const doc = makeDoc();
    const send = doc.tracks[1].mixer?.sends[0];
    if (!send) throw new Error('missing send fixture');
    send.timing = 'preFader';
    const engines: FakeEngine[] = [];
    await renderProjectWithEngine(doc, {
      deps: null,
      loadAudioAsset: async () => fakeAsset(),
      createEngine: () => {
        const engine = new FakeEngine();
        engines.push(engine);
        return engine;
      },
      stems: true,
    });
    const keysStemLanes = engines[1].named('setTrackLanes')[0][1] as Array<{
      trackId: number;
      sends?: unknown[];
    }>;
    expect(keysStemLanes[1]).toEqual({ trackId: 2 });
  });

  it('refuses return stems when all engine bus slots are occupied', async () => {
    const doc = makeDoc();
    if (!doc.mixer) throw new Error('missing mixer');
    for (let index = 1; index < 8; index++) {
      doc.mixer.buses.push({ id: `bus-${index}`, name: `Bus ${index}`, gainDb: 0 });
    }
    await expect(
      renderProjectWithEngine(doc, {
        ...renderOptions(new FakeEngine()),
        stems: true,
        busStems: true,
      }),
    ).rejects.toThrow(/Return stems require one free engine bus/);
  });

  it('reuses an existing return-solo discard bus for return stems', async () => {
    const doc = makeDoc();
    if (!doc.mixer) throw new Error('missing mixer');
    doc.mixer.buses[0].solo = true;
    for (let index = 1; index < 7; index++) {
      doc.mixer.buses.push({ id: `bus-${index}`, name: `Bus ${index}`, gainDb: 0 });
    }
    const engines: FakeEngine[] = [];
    await renderProjectWithEngine(doc, {
      ...renderOptions(new FakeEngine()),
      createEngine: () => {
        const engine = new FakeEngine();
        engines.push(engine);
        return engine;
      },
      stems: true,
      busStems: true,
    });
    const declarations = engines.flatMap((engine) => engine.named('setTrackBuses'));
    expect(declarations.length).toBeGreaterThan(1);
    expect(declarations.every(([, buses]) => (buses as unknown[]).length === 8)).toBe(true);
  });

  it('refuses return stems whose nested bus graph would make stems overlap', async () => {
    const doc = makeDoc();
    if (!doc.mixer) throw new Error('missing mixer');
    doc.mixer.buses.push({ id: 'bus-b', name: 'B', gainDb: 0 });
    doc.mixer.buses[0].strip = {
      gainDb: 0,
      pan: 0,
      inserts: [],
      sends: [],
      outputBusId: 'bus-b',
    };
    await expect(
      renderProjectWithEngine(doc, {
        ...renderOptions(new FakeEngine()),
        stems: true,
        busStems: true,
      }),
    ).rejects.toThrow(/Return stems cannot isolate nested bus routing/);
  });

  it('refuses return stems when a bus insert keys from another bus', async () => {
    const doc = makeDoc();
    if (!doc.mixer) throw new Error('missing mixer');
    doc.mixer.buses.push({ id: 'bus-b', name: 'B', gainDb: 0 });
    doc.mixer.buses[0].strip = {
      gainDb: 0,
      pan: 0,
      sends: [],
      inserts: [
        {
          processor: 'dynamics.duckingProcessor',
          params: {},
          enabled: true,
          sidechainSourceBusId: 'bus-b',
        },
      ],
    };
    await expect(
      renderProjectWithEngine(doc, {
        ...renderOptions(new FakeEngine()),
        stems: true,
        busStems: true,
      }),
    ).rejects.toThrow(/Return stems cannot isolate nested bus routing or bus sidechain keys/);
  });

  it('applies MIDI clip fades to the instrument audio over the clip span', async () => {
    const doc = makeDoc();
    doc.tracks[1].mute = true;
    doc.tracks[0].clips[0].fadeInPpq = 1;
    doc.tracks[0].clips[0].fadeOutPpq = 1;
    doc.tracks[0].clips[0].notes = [
      { pitch: 60, velocity: 100, startPpq: 0, durationPpq: 4, channel: 0 },
    ];

    const result = await renderProjectWithEngine(doc, renderOptions(new AudibilityEngine()));
    const level = defaultMidiLevel(100);
    expect(result.channels[0][0]).toBeCloseTo(0, 5);
    expect(result.channels[0][Math.round(SAMPLES_PER_PPQ / 2)]).toBeCloseTo(level * 0.5, 5);
    expect(result.channels[0][2 * SAMPLES_PER_PPQ]).toBeCloseTo(level, 5);
    expect(result.channels[0][Math.round(3.5 * SAMPLES_PER_PPQ)]).toBeCloseTo(level * 0.5, 5);
  });

  it('sums simultaneous MIDI notes by their audible velocities', async () => {
    const doc = makeDoc();
    doc.tracks[1].mute = true;
    doc.tracks[0].clips[0].notes = [
      { pitch: 60, velocity: 64, startPpq: 0, durationPpq: 1, channel: 0 },
      { pitch: 67, velocity: 96, startPpq: 0, durationPpq: 1, channel: 0 },
    ];

    const result = await renderProjectWithEngine(doc, renderOptions(new AudibilityEngine()));
    const masterGain = 10 ** (-3 / 20);

    expect(result.channels[0][0]).toBeCloseTo(
      (midiAmplitude(64) + midiAmplitude(96)) * defaultMidiLaneGain() * masterGain,
      5,
    );
  });

  it('sums simultaneous MIDI notes across channels without dropping either note', async () => {
    const doc = makeDoc();
    doc.tracks[1].mute = true;
    doc.tracks[0].clips[0].notes = [
      { pitch: 60, velocity: 48, startPpq: 0, durationPpq: 1, channel: 0 },
      { pitch: 60, velocity: 80, startPpq: 0, durationPpq: 1, channel: 1 },
    ];

    const result = await renderProjectWithEngine(doc, renderOptions(new AudibilityEngine()));

    expect(result.channels[0][0]).toBeCloseTo(
      (midiAmplitude(48) + midiAmplitude(80)) * defaultMidiLaneGain() * defaultMasterGain(),
      5,
    );
  });

  it('keeps overlapping same-pitch MIDI notes audible until the last note-off', async () => {
    const doc = makeDoc();
    doc.tracks[1].mute = true;
    doc.tracks[0].clips[0].notes = [
      { pitch: 60, velocity: 64, startPpq: 0, durationPpq: 2, channel: 0 },
      { pitch: 60, velocity: 32, startPpq: 1, durationPpq: 2, channel: 0 },
    ];

    const result = await renderProjectWithEngine(doc, renderOptions(new AudibilityEngine()));
    const masterGain = 10 ** (-3 / 20);

    expect(result.channels[0][0]).toBeCloseTo(defaultMidiLevel(64, masterGain), 5);
    expect(result.channels[0][SAMPLES_PER_PPQ]).toBeCloseTo(
      (midiAmplitude(64) + midiAmplitude(32)) * defaultMidiLaneGain() * masterGain,
      5,
    );
    expect(result.channels[0][2 * SAMPLES_PER_PPQ - 1]).toBeCloseTo(
      defaultMidiLevel(32, masterGain),
      5,
    );
    expect(result.channels[0][3 * SAMPLES_PER_PPQ - 1]).toBeCloseTo(0, 5);
  });

  it('renders audible MIDI clip loops and drops notes outside the loop region', async () => {
    const doc = makeDoc();
    doc.tracks[1].mute = true;
    const clip = doc.tracks[0].clips[0];
    clip.lengthPpq = 4;
    clip.loopEnabled = true;
    clip.loopLengthPpq = 2;
    clip.notes = [
      { pitch: 60, velocity: 96, startPpq: 0, durationPpq: 1, channel: 0 },
      { pitch: 64, velocity: 96, startPpq: 3, durationPpq: 1, channel: 0 },
    ];

    const result = await renderProjectWithEngine(doc, renderOptions(new AudibilityEngine()));

    expect(result.channels[0][0]).toBeCloseTo(defaultMidiLevel(96), 5);
    expect(result.channels[0][SAMPLES_PER_PPQ]).toBeCloseTo(0, 5);
    expect(result.channels[0][2 * SAMPLES_PER_PPQ]).toBeCloseTo(defaultMidiLevel(96), 5);
    expect(result.channels[0][3 * SAMPLES_PER_PPQ]).toBeCloseTo(0, 5);
  });

  it('sums overlapping MIDI and audio content into the stereo output', async () => {
    const doc = makeDoc();
    doc.tracks[1].clips[0].startPpq = 0;
    doc.tracks[1].clips[0].lengthPpq = 1;

    const result = await renderProjectWithEngine(doc, renderOptions(new AudibilityEngine()));
    const masterGain = 10 ** (-3 / 20);
    const expected =
      midiAmplitude(96) * defaultMidiLaneGain() * masterGain +
      defaultAudioLevel(0.5, 0.8, masterGain);

    expect(result.channels[0][0]).toBeCloseTo(expected, 5);
    expect(result.channels[1][0]).toBeCloseTo(
      midiAmplitude(96) * defaultMidiLaneGain() * masterGain +
        defaultAudioLevel(0.5, 0.8, masterGain) * 0.75,
      5,
    );
  });

  it('renders a range starting inside a sustained MIDI note from output frame zero', async () => {
    const doc = makeDoc();
    doc.tracks[1].mute = true;
    doc.tracks[0].clips[0].notes = [
      { pitch: 60, velocity: 96, startPpq: 0, durationPpq: 4, channel: 0 },
    ];

    const result = await renderProjectWithEngine(doc, {
      ...renderOptions(new AudibilityEngine()),
      range: { startPpq: 1, endPpq: 3 },
    });

    expect(result.totalFrames).toBe(2 * SAMPLES_PER_PPQ);
    expect(result.channels[0][0]).toBeCloseTo(defaultMidiLevel(96), 5);
    expect(result.channels[0][result.totalFrames - 1]).toBeCloseTo(defaultMidiLevel(96), 5);
  });

  it('can append a release tail to an explicit render range', async () => {
    const doc = makeDoc();
    doc.tracks[1].mute = true;
    const result = await renderProjectWithEngine(doc, {
      ...renderOptions(new AudibilityEngine()),
      range: { startPpq: 1, endPpq: 3 },
      releaseTailSeconds: 1.5,
      appendReleaseTailForExplicitRange: true,
    });

    expect(result.totalFrames).toBe(2 * SAMPLES_PER_PPQ + 1.5 * 48000);
  });

  it('sizes the release tail from the engine-reported tail on request', async () => {
    const doc = makeDoc();
    doc.tracks[1].mute = true;
    const engines: FakeEngine[] = [];
    const result = await renderProjectWithEngine(doc, {
      deps: null,
      loadAudioAsset: async () => fakeAsset(),
      createEngine: () => {
        const engine = new FakeEngine();
        engine.tail = 3 * 48000;
        engines.push(engine);
        return engine;
      },
      releaseTailSeconds: 1,
      releaseTailFromEngine: true,
    });

    // Content ends at ppq 4 (2 s at 120 BPM); the engine tail replaces the 1 s option.
    expect(result.totalFrames).toBe(2 * 48000 + 3 * 48000);
    // The measuring engine holds the program but no clips, and is released.
    expect(engines).toHaveLength(2);
    expect(engines[0].destroyed).toBe(true);
    expect(engines[0].named('setClips')).toEqual([]);
    expect(engines[0].named('setTrackLanes')).toHaveLength(1);
  });

  it('trims only the decayed part of an appended tail', () => {
    const left = Float32Array.from([0.5, 0, 0, 0.2, 1e-6, 0, 0]);
    const right = Float32Array.from([0.5, 0, 0, 0, 0, 2e-5, 0]);
    // The right channel still rings at frame 5, so frames up to it stay.
    expect(trimDecayedTail([left, right], 2).map((channel) => channel.length)).toEqual([6, 6]);
    // Below the floor nothing is cut, even when silent.
    const silent = [new Float32Array(4), new Float32Array(4)];
    expect(trimDecayedTail(silent, 3).map((channel) => channel.length)).toEqual([3, 3]);
    const loud = [Float32Array.from([1, 1]), Float32Array.from([1, 1])];
    expect(trimDecayedTail(loud, 0)).toBe(loud);
  });

  it('caps an unbounded engine tail and ignores one the engine cannot report', async () => {
    const make = (tail: number | null) => ({
      deps: null,
      loadAudioAsset: async () => fakeAsset(),
      createEngine: () => {
        const engine = new FakeEngine();
        engine.tail = tail ?? 0;
        if (tail === null) (engine as { tailSamples?: unknown }).tailSamples = undefined;
        return engine;
      },
      range: { startPpq: 0, endPpq: 4 },
      appendReleaseTailForExplicitRange: true,
      releaseTailSeconds: 1,
      releaseTailFromEngine: true,
    });
    const unbounded = await renderProjectWithEngine(makeDoc(), make(2147483647));
    expect(unbounded.totalFrames).toBe(2 * 48000 + MAX_RELEASE_TAIL_SECONDS * 48000);
    const silent = await renderProjectWithEngine(makeDoc(), make(null));
    expect(silent.totalFrames).toBe(2 * 48000 + 48000);
  });

  it('uses bounded time-effect history before a windowed render', async () => {
    const doc = makeDoc();
    doc.mixer = {
      ...doc.mixer,
      master: {
        ...doc.mixer!.master,
        inserts: [{ processor: 'reverb.algorithmic', params: { decaySeconds: 20 }, enabled: true }],
      },
    };
    const engine = new FakeEngine();

    await renderProjectWithEngine(doc, {
      ...renderOptions(engine),
      range: { startPpq: 30, endPpq: 31 },
      releaseTailSeconds: 0,
      insertTail: () => 20,
    });

    // The 20-second release suggestion is capped at 10 seconds. At 120 BPM,
    // PPQ 30 starts 15 seconds into the timeline, leaving 5 seconds to roll.
    expect(engine.named('seekSample')[0][1]).toBe(5 * 48000);
  });

  it('renders a range starting inside an audio clip from the matching clip frame', async () => {
    const doc = makeDoc();
    doc.tracks[0].mute = true;
    doc.tracks[1].clips[0].startPpq = 1;
    doc.tracks[1].clips[0].lengthPpq = 4;

    const ramp = new Float32Array(48000);
    for (let i = 0; i < ramp.length; i++) ramp[i] = i / 48000;
    const result = await renderProjectWithEngine(doc, {
      deps: null,
      createEngine: () => new AudibilityEngine(),
      loadAudioAsset: async () => ({
        meta: {
          id: 'asset-1',
          name: 'range-ramp.wav',
          sampleRate: 48000,
          numChannels: 1,
          numFrames: ramp.length,
        },
        channels: [ramp],
      }),
      range: { startPpq: 2, endPpq: 3 },
    });

    expect(result.totalFrames).toBe(SAMPLES_PER_PPQ);
    // The render starts one PPQ after the audio clip start, so output frame 0
    // reads source/render clip frame 24000.
    expect(result.channels[0][0]).toBeCloseTo(defaultAudioLevel(24000 / 48000), 5);
  });

  it('renders the loop range with audible MIDI and audio from loop frame zero', async () => {
    const doc = makeDoc();
    doc.tracks[0].clips[0].notes = [
      { pitch: 60, velocity: 96, startPpq: 0, durationPpq: 4, channel: 0 },
    ];
    doc.tracks[1].clips[0].startPpq = 1;
    doc.tracks[1].clips[0].lengthPpq = 4;

    const result = await renderProjectWithEngine(doc, {
      ...renderOptions(new AudibilityEngine()),
      range: 'loop',
      loopRegion: { startPpq: 2, endPpq: 3 },
    });
    const expected = defaultMidiLevel(96) + defaultAudioLevel(0.5);

    expect(result.totalFrames).toBe(SAMPLES_PER_PPQ);
    expect(result.channels[0][0]).toBeCloseTo(expected, 5);
    expect(result.channels[1][0]).toBeCloseTo(
      defaultMidiLevel(96) + defaultAudioLevel(0.5) * 0.75,
      5,
    );
  });

  it('renders range stems from the matching MIDI and audio frame zero', async () => {
    const doc = makeDoc();
    doc.tracks[0].clips[0].notes = [
      { pitch: 60, velocity: 96, startPpq: 0, durationPpq: 4, channel: 0 },
    ];
    doc.tracks[1].clips[0].startPpq = 1;
    doc.tracks[1].clips[0].lengthPpq = 4;

    const ramp = new Float32Array(48000);
    for (let i = 0; i < ramp.length; i++) ramp[i] = i / 48000;
    const result = await renderProjectWithEngine(doc, {
      deps: null,
      createEngine: () => new AudibilityEngine(),
      loadAudioAsset: async () => ({
        meta: {
          id: 'asset-1',
          name: 'range-stem-ramp.wav',
          sampleRate: 48000,
          numChannels: 1,
          numFrames: ramp.length,
        },
        channels: [ramp],
      }),
      range: { startPpq: 2, endPpq: 3 },
      stems: true,
    });

    const keysStem = result.stems?.find((stem) => stem.name === 'Keys');
    const drumsStem = result.stems?.find((stem) => stem.name === 'Drums');
    expect(result.totalFrames).toBe(SAMPLES_PER_PPQ);
    expect(keysStem?.channels[0][0]).toBeCloseTo(defaultMidiLevel(96, 1), 5);
    expect(drumsStem?.channels[0][0]).toBeCloseTo(
      (24000 / 48000) * 0.8 * defaultAudioLaneGain(),
      5,
    );
  });

  it('renders master fader automation as audible level changes', async () => {
    const doc = makeDoc();
    doc.tracks[1].mute = true;
    doc.tracks[0].automation = [];
    doc.tracks[0].volume = 1;
    doc.tracks[0].clips[0].notes = [
      { pitch: 60, velocity: 127, startPpq: 0, durationPpq: 4, channel: 0 },
    ];
    doc.masterAutomation = [
      {
        param: 'faderDb',
        enabled: true,
        points: [
          { ppq: 0, value: -12 },
          { ppq: 2, value: 0 },
        ],
      },
    ];

    const result = await renderProjectWithEngine(doc, renderOptions(new AudibilityEngine()));

    expect(result.channels[0][0]).toBeCloseTo(10 ** (-12 / 20), 5);
    expect(result.channels[0][2 * SAMPLES_PER_PPQ - 1]).toBeCloseTo(10 ** (-12 / 20), 5);
    expect(result.channels[0][2 * SAMPLES_PER_PPQ]).toBeCloseTo(1, 5);
  });

  it('renders track fader automation as audible level changes', async () => {
    const doc = makeDoc();
    doc.tracks[1].mute = true;
    doc.tracks[0].volume = 1;
    doc.tracks[0].clips[0].notes = [
      { pitch: 60, velocity: 127, startPpq: 0, durationPpq: 4, channel: 0 },
    ];
    doc.tracks[0].automation = [
      {
        param: 'faderDb',
        enabled: true,
        points: [
          { ppq: 0, value: -12 },
          { ppq: 2, value: 0 },
        ],
      },
    ];

    const result = await renderProjectWithEngine(doc, renderOptions(new AudibilityEngine()));
    const masterGain = defaultMasterGain();

    expect(result.channels[0][0]).toBeCloseTo(dbGain(-12) * masterGain, 5);
    expect(result.channels[0][2 * SAMPLES_PER_PPQ - 1]).toBeCloseTo(dbGain(-12) * masterGain, 5);
    expect(result.channels[0][2 * SAMPLES_PER_PPQ]).toBeCloseTo(masterGain, 5);
  });

  it('adds only the VCA offset to exported absolute track fader automation', async () => {
    const doc = makeDoc();
    doc.tracks[1].mute = true;
    doc.tracks[0].volume = 0.5;
    doc.tracks[0].mixer = { gainDb: -6, pan: 0, inserts: [], sends: [] };
    doc.tracks[0].vcaId = 'vca-1';
    doc.mixer = {
      ...doc.mixer,
      vcaGroups: [{ id: 'vca-1', name: 'VCA 1', gainDb: -3 }],
    };
    doc.tracks[0].clips[0].notes = [
      { pitch: 60, velocity: 127, startPpq: 0, durationPpq: 4, channel: 0 },
    ];
    doc.tracks[0].automation = [
      {
        param: 'faderDb',
        enabled: true,
        points: [{ ppq: 0, value: -10 }],
      },
    ];

    const result = await renderProjectWithEngine(doc, renderOptions(new AudibilityEngine()));

    expect(result.channels[0][0]).toBeCloseTo(dbGain(-13) * defaultMasterGain(), 5);
  });

  it('folds VCA mute into exported member lane mute', async () => {
    const doc = makeDoc();
    doc.tracks[1].mute = true;
    doc.tracks[0].vcaId = 'vca-1';
    doc.mixer = {
      ...doc.mixer,
      vcaGroups: [{ id: 'vca-1', name: 'VCA 1', gainDb: 0, mute: true }],
    };

    const result = await renderProjectWithEngine(doc, renderOptions(new AudibilityEngine()));

    expect(result.channels[0][0]).toBeCloseTo(0, 5);
  });

  it('folds VCA solo into exported member lane solo', async () => {
    const doc = makeDoc();
    doc.tracks[0].vcaId = 'vca-1';
    doc.tracks[0].clips[0].notes = [
      { pitch: 60, velocity: 96, startPpq: 0, durationPpq: 4, channel: 0 },
    ];
    doc.tracks[1].clips[0].startPpq = 0;
    doc.tracks[1].clips[0].lengthPpq = 4;
    doc.mixer = {
      ...doc.mixer,
      vcaGroups: [{ id: 'vca-1', name: 'VCA 1', gainDb: 0, solo: true }],
    };

    const result = await renderProjectWithEngine(doc, renderOptions(new AudibilityEngine()));

    expect(result.channels[0][0]).toBeCloseTo(defaultMidiLevel(96), 5);
  });

  it('renders audio track fader automation as audible level changes', async () => {
    const doc = makeDoc();
    doc.tracks[0].mute = true;
    doc.tracks[1].volume = 1;
    const mixer = doc.tracks[1].mixer as NonNullable<(typeof doc.tracks)[number]['mixer']>;
    mixer.gainDb = 0;
    doc.tracks[1].clips[0].startPpq = 0;
    doc.tracks[1].clips[0].lengthPpq = 4;
    doc.tracks[1].automation = [
      {
        param: 'faderDb',
        enabled: true,
        points: [
          { ppq: 0, value: -18 },
          { ppq: 1, value: 0 },
        ],
      },
    ];

    const result = await renderProjectWithEngine(doc, renderOptions(new AudibilityEngine()));
    const masterGain = defaultMasterGain();

    expect(result.channels[0][0]).toBeCloseTo(0.5 * 0.8 * dbGain(-18) * masterGain, 5);
    expect(result.channels[0][SAMPLES_PER_PPQ - 1]).toBeCloseTo(
      0.5 * 0.8 * dbGain(-18) * masterGain,
      5,
    );
    expect(result.channels[0][SAMPLES_PER_PPQ]).toBeCloseTo(0.5 * 0.8 * masterGain, 5);
  });

  it('starts ranged renders with the active master and track automation values', async () => {
    const doc = makeDoc();
    doc.tracks[0].mute = true;
    doc.tracks[1].volume = 1;
    const mixer = doc.tracks[1].mixer as NonNullable<(typeof doc.tracks)[number]['mixer']>;
    mixer.gainDb = 0;
    doc.tracks[1].clips[0].startPpq = 0;
    doc.tracks[1].clips[0].lengthPpq = 4;
    doc.tracks[1].automation = [
      {
        param: 'faderDb',
        enabled: true,
        points: [
          { ppq: 0, value: -24 },
          { ppq: 1, value: -6 },
        ],
      },
    ];
    doc.masterAutomation = [
      {
        param: 'faderDb',
        enabled: true,
        points: [
          { ppq: 0, value: -18 },
          { ppq: 1, value: -3 },
        ],
      },
    ];

    const result = await renderProjectWithEngine(doc, {
      ...renderOptions(new AudibilityEngine()),
      range: { startPpq: 1, endPpq: 2 },
    });

    expect(result.totalFrames).toBe(SAMPLES_PER_PPQ);
    expect(result.channels[0][0]).toBeCloseTo(0.5 * 0.8 * dbGain(-6) * dbGain(-3), 5);
  });

  it('renders stems with track fader automation but without master gain', async () => {
    const doc = makeDoc();
    doc.tracks[1].mute = true;
    doc.tracks[0].volume = 1;
    doc.tracks[0].clips[0].notes = [
      { pitch: 60, velocity: 127, startPpq: 0, durationPpq: 4, channel: 0 },
    ];
    doc.tracks[0].automation = [
      {
        param: 'faderDb',
        enabled: true,
        points: [
          { ppq: 0, value: -12 },
          { ppq: 2, value: 0 },
        ],
      },
    ];

    const result = await renderProjectWithEngine(doc, {
      deps: null,
      createEngine: () => new AudibilityEngine(),
      loadAudioAsset: async () => fakeAsset(),
      stems: true,
    });

    const keysStem = result.stems?.find((stem) => stem.name === 'Keys');
    expect(keysStem?.channels[0][0]).toBeCloseTo(dbGain(-12), 5);
    expect(keysStem?.channels[0][2 * SAMPLES_PER_PPQ - 1]).toBeCloseTo(dbGain(-12), 5);
    expect(keysStem?.channels[0][2 * SAMPLES_PER_PPQ]).toBeCloseTo(1, 5);
  });

  it('routes an insert-parameter lane to its resolved insert id, not the fader id', async () => {
    const doc = makeDoc();
    // Track 0 and master each carry only an insert-parameter automation lane.
    doc.tracks[0].mixer = {
      gainDb: 0,
      pan: 0,
      inserts: [{ id: 'track-gain', processor: 'gain.gain', params: { gainDb: 0 }, enabled: true }],
      sends: [],
    };
    doc.mixer = doc.mixer ?? {
      master: { gainDb: 0, pan: 0, inserts: [], sends: [] },
      buses: [],
    };
    doc.mixer.master.inserts = [
      { id: 'master-gain', processor: 'gain.gain', params: { gainDb: 0 }, enabled: true },
    ];
    doc.tracks[0].automation = [
      {
        param: insertAutomationParam('track-gain', 'gainDb'),
        enabled: true,
        points: [{ ppq: 0, value: 3 }],
      },
    ];
    doc.masterAutomation = [
      {
        param: insertAutomationParam('master-gain', 'gainDb'),
        enabled: true,
        points: [{ ppq: 0, value: 3 }],
      },
    ];

    const engine = new FakeEngine();
    await renderProjectWithEngine(doc, renderOptions(engine));

    const trackFaderId = ENGINE_MIXER_TARGET_BASE | (0 << 8) | ENGINE_MIXER_PARAM_FADER_DB;
    const masterFaderId = MASTER_FADER_PARAM_ID;
    const automated = new Set(engine.named('setAutomationLane').map(([, id]) => id as number));
    // The insert lanes resolve to their reserved insert ids, never the fader id.
    expect(automated.has(trackFaderId)).toBe(false);
    expect(automated.has(masterFaderId)).toBe(false);
    // Track 0 is engine track id 1 (positional ids are 1-based).
    const trackInsertId = (0xe0000000 | (1 << 16) | (0 << 8)) >>> 0;
    const masterInsertId = (0xe1ff0000 | (0 << 8)) >>> 0;
    expect(automated.has(trackInsertId)).toBe(true);
    expect(automated.has(masterInsertId)).toBe(true);
  });

  it('renders MIDI after a tempo change at the tempo-mapped sample position', async () => {
    const doc = makeDoc();
    doc.tempoSegments = [
      { startPpq: 0, bpm: 120 },
      { startPpq: 4, bpm: 60 },
    ];
    doc.tracks[1].mute = true;
    doc.tracks[0].clips[0].startPpq = 4;
    doc.tracks[0].clips[0].lengthPpq = 2;
    doc.tracks[0].clips[0].notes = [
      { pitch: 60, velocity: 96, startPpq: 0, durationPpq: 1, channel: 0 },
    ];

    const result = await renderProjectWithEngine(doc, renderOptions(new AudibilityEngine()));
    const noteStart = 4 * SAMPLES_PER_PPQ;
    const slowPpqFrames = 2 * SAMPLES_PER_PPQ;

    expect(result.channels[0][noteStart - 1]).toBeCloseTo(0, 5);
    expect(result.channels[0][noteStart]).toBeCloseTo(midiAmplitude(96) * defaultMasterGain(), 5);
    expect(result.channels[0][noteStart + slowPpqFrames - 2]).toBeCloseTo(
      midiAmplitude(96) * defaultMasterGain(),
      5,
    );
    expect(result.channels[0][noteStart + slowPpqFrames - 1]).toBeCloseTo(0, 5);
  });

  it('renders audio after a tempo change at the tempo-mapped sample position', async () => {
    const doc = makeDoc();
    doc.tempoSegments = [
      { startPpq: 0, bpm: 120 },
      { startPpq: 4, bpm: 60 },
    ];
    doc.tracks[0].mute = true;
    doc.tracks[1].clips[0].startPpq = 5;
    doc.tracks[1].clips[0].lengthPpq = 1;

    const result = await renderProjectWithEngine(doc, renderOptions(new AudibilityEngine()));
    // PPQ 4 is 96k frames at 120 BPM. One more PPQ at 60 BPM adds 48k.
    const audioStart = 4 * SAMPLES_PER_PPQ + 2 * SAMPLES_PER_PPQ;

    expect(result.channels[0][audioStart - 1]).toBeCloseTo(0, 5);
    expect(result.channels[0][audioStart]).toBeCloseTo(defaultAudioLevel(0.5), 5);
  });

  it('renders audio clip source-offset samples in the audible output', async () => {
    const doc = makeDoc();
    doc.tracks[0].mute = true;
    doc.tracks[1].clips[0].sourceOffsetPpq = 1;
    doc.tracks[1].clips[0].lengthPpq = 1;

    const ramp = new Float32Array(48000);
    for (let i = 0; i < ramp.length; i++) ramp[i] = i / 48000;
    const result = await renderProjectWithEngine(doc, {
      deps: null,
      createEngine: () => new AudibilityEngine(),
      loadAudioAsset: async () => ({
        meta: {
          id: 'asset-1',
          name: 'ramp.wav',
          sampleRate: 48000,
          numChannels: 1,
          numFrames: ramp.length,
        },
        channels: [ramp],
      }),
    });

    const masterGain = 10 ** (-3 / 20);
    const audioStart = 2 * SAMPLES_PER_PPQ;
    expect(result.channels[0][audioStart]).toBeCloseTo(
      defaultAudioLevel(24000 / 48000, 0.8, masterGain),
      5,
    );
    expect(result.channels[0][audioStart + 1000]).toBeCloseTo(
      defaultAudioLevel(25000 / 48000, 0.8, masterGain),
      5,
    );
  });

  it('keeps audio clips silent after the loaded source asset ends', async () => {
    const doc = makeDoc();
    doc.tracks[0].mute = true;
    doc.tracks[1].clips[0].startPpq = 0;
    doc.tracks[1].clips[0].lengthPpq = 4;
    const source = new Float32Array(SAMPLES_PER_PPQ).fill(0.5);

    const result = await renderProjectWithEngine(doc, {
      deps: null,
      createEngine: () => new AudibilityEngine(),
      loadAudioAsset: async () => ({
        meta: {
          id: 'asset-1',
          name: 'short.wav',
          sampleRate: 48000,
          numChannels: 1,
          numFrames: source.length,
        },
        channels: [source],
      }),
    });

    expect(result.channels[0][SAMPLES_PER_PPQ - 1]).toBeCloseTo(defaultAudioLevel(0.5), 5);
    expect(result.channels[0][SAMPLES_PER_PPQ]).toBeCloseTo(0, 5);
    expect(result.channels[1][SAMPLES_PER_PPQ]).toBeCloseTo(0, 5);
  });

  it('renders resampled audio asset samples at the project sample rate', async () => {
    const doc = makeDoc();
    doc.tracks[0].mute = true;
    doc.tracks[1].clips[0].lengthPpq = 1;

    const sourceRate = 24000;
    const source = new Float32Array(sourceRate);
    for (let i = 0; i < source.length; i++) source[i] = i / sourceRate;
    const result = await renderProjectWithEngine(doc, {
      deps: null,
      createEngine: () => new AudibilityEngine(),
      resampleAudio: resample,
      loadAudioAsset: async () => ({
        meta: {
          id: 'asset-1',
          name: 'half-rate-ramp.wav',
          sampleRate: sourceRate,
          numChannels: 1,
          numFrames: source.length,
        },
        channels: [source],
      }),
    });

    const masterGain = 10 ** (-3 / 20);
    const audioStart = 2 * SAMPLES_PER_PPQ;
    // One PPQ is 0.5s: 12k source frames become 24k render frames.
    expect(result.channels[0][audioStart]).toBeCloseTo(0, 5);
    expect(result.channels[0][audioStart + SAMPLES_PER_PPQ - 1]).toBeCloseTo(
      defaultAudioLevel(11999 / sourceRate, 0.8, masterGain),
      4,
    );
    expect(resample).toHaveBeenCalledWith(expect.any(Float32Array), sourceRate, 48000);
  });

  it('renders stereo audio asset channels independently', async () => {
    const doc = makeDoc();
    doc.tracks[0].mute = true;
    doc.tracks[1].clips[0].lengthPpq = 1;

    const frames = 48000;
    const left = new Float32Array(frames).fill(0.25);
    const right = new Float32Array(frames).fill(0.75);
    const result = await renderProjectWithEngine(doc, {
      deps: null,
      createEngine: () => new AudibilityEngine(),
      loadAudioAsset: async () => ({
        meta: {
          id: 'asset-1',
          name: 'stereo.wav',
          sampleRate: 48000,
          numChannels: 2,
          numFrames: frames,
        },
        channels: [left, right],
      }),
    });

    const masterGain = 10 ** (-3 / 20);
    const audioStart = 2 * SAMPLES_PER_PPQ;
    expect(result.channels[0][audioStart]).toBeCloseTo(defaultAudioLevel(0.25, 0.8, masterGain), 5);
    expect(result.channels[1][audioStart]).toBeCloseTo(
      defaultAudioLevel(0.75, 0.8, masterGain) * 0.75,
      5,
    );
  });

  it('keeps gain-zero audio clips silent and out of the engine clip list', async () => {
    const doc = makeDoc();
    doc.tracks[0].mute = true;
    doc.tracks[1].clips[0].gain = 0;
    const engine = new AudibilityEngine();

    const result = await renderProjectWithEngine(doc, renderOptions(engine));

    expect(engine.named('setClips')).toEqual([]);
    expect(result.channels[0][2 * SAMPLES_PER_PPQ]).toBeCloseTo(0, 5);
    expect(result.channels[1][2 * SAMPLES_PER_PPQ]).toBeCloseTo(0, 5);
  });

  it('duplicates mono audio assets to the right channel audibly', async () => {
    const doc = makeDoc();
    doc.tracks[0].mute = true;
    doc.tracks[1].clips[0].lengthPpq = 1;

    const mono = new Float32Array(48000).fill(0.6);
    const result = await renderProjectWithEngine(doc, {
      deps: null,
      createEngine: () => new AudibilityEngine(),
      loadAudioAsset: async () => ({
        meta: {
          id: 'asset-1',
          name: 'mono.wav',
          sampleRate: 48000,
          numChannels: 1,
          numFrames: mono.length,
        },
        channels: [mono],
      }),
    });

    const expected = defaultAudioLevel(0.6);
    const audioStart = 2 * SAMPLES_PER_PPQ;
    expect(result.channels[0][audioStart]).toBeCloseTo(expected, 5);
    expect(result.channels[1][audioStart]).toBeCloseTo(expected * 0.75, 5);
  });

  it('renders baked audio clip fades in the audible output', async () => {
    const doc = makeDoc();
    doc.tracks[0].mute = true;
    doc.tracks[1].clips[0].fadeInPpq = 1;
    doc.tracks[1].clips[0].fadeOutPpq = 1;
    const result = await renderProjectWithEngine(doc, renderOptions(new AudibilityEngine()));
    const masterGain = 10 ** (-3 / 20);
    const audioStart = 2 * SAMPLES_PER_PPQ;

    expect(result.channels[0][audioStart]).toBeCloseTo(0, 5);
    expect(result.channels[0][audioStart + SAMPLES_PER_PPQ / 2]).toBeCloseTo(
      defaultAudioLevel(0.5 * 0.5, 0.8, masterGain),
      5,
    );
    expect(result.channels[0][audioStart + SAMPLES_PER_PPQ]).toBeCloseTo(
      defaultAudioLevel(0.5, 0.8, masterGain),
      4,
    );
    expect(result.channels[0][audioStart + 2 * SAMPLES_PER_PPQ - 1]).toBeCloseTo(0, 5);
  });

  it('renders baked fades independently on stereo audio channels', async () => {
    const doc = makeDoc();
    doc.tracks[0].mute = true;
    doc.tracks[1].clips[0].fadeInPpq = 1;
    doc.tracks[1].clips[0].fadeOutPpq = 1;
    const frames = 48000;
    const left = new Float32Array(frames).fill(0.25);
    const right = new Float32Array(frames).fill(0.75);

    const result = await renderProjectWithEngine(doc, {
      deps: null,
      createEngine: () => new AudibilityEngine(),
      loadAudioAsset: async () => ({
        meta: {
          id: 'asset-1',
          name: 'fade-stereo.wav',
          sampleRate: 48000,
          numChannels: 2,
          numFrames: frames,
        },
        channels: [left, right],
      }),
    });
    const audioStart = 2 * SAMPLES_PER_PPQ;
    const fadeMid = audioStart + SAMPLES_PER_PPQ / 2;

    expect(result.channels[0][fadeMid]).toBeCloseTo(defaultAudioLevel(0.25 * 0.5), 5);
    expect(result.channels[1][fadeMid]).toBeCloseTo(defaultAudioLevel(0.75 * 0.5) * 0.75, 5);
    expect(result.channels[0][audioStart + 2 * SAMPLES_PER_PPQ - 1]).toBeCloseTo(0, 5);
    expect(result.channels[1][audioStart + 2 * SAMPLES_PER_PPQ - 1]).toBeCloseTo(0, 5);
  });

  it('keeps muted tracks silent in the rendered output', async () => {
    const doc = makeDoc();
    doc.tracks[1].mute = true;
    const result = await renderProjectWithEngine(doc, renderOptions(new AudibilityEngine()));

    expect(result.channels[0][0]).toBeGreaterThan(0);
    expect(result.channels[0][2 * SAMPLES_PER_PPQ]).toBeCloseTo(0, 5);
  });

  it('renders only soloed lanes while preserving solo-safe lanes', async () => {
    const soloDoc = makeDoc();
    soloDoc.tracks[1].solo = true;
    const soloOnly = await renderProjectWithEngine(soloDoc, renderOptions(new AudibilityEngine()));
    expect(soloOnly.channels[0][0]).toBeCloseTo(0, 5);
    expect(soloOnly.channels[0][2 * SAMPLES_PER_PPQ]).toBeGreaterThan(0);

    const soloSafeDoc = makeDoc();
    soloSafeDoc.tracks[0].soloSafe = true;
    soloSafeDoc.tracks[1].solo = true;
    const withSoloSafe = await renderProjectWithEngine(
      soloSafeDoc,
      renderOptions(new AudibilityEngine()),
    );
    expect(withSoloSafe.channels[0][0]).toBeGreaterThan(0);
    expect(withSoloSafe.channels[0][2 * SAMPLES_PER_PPQ]).toBeGreaterThan(0);
  });

  it('keeps muted solo and muted solo-safe lanes silent', async () => {
    const mutedSoloDoc = makeDoc();
    mutedSoloDoc.tracks[1].solo = true;
    mutedSoloDoc.tracks[1].mute = true;
    const mutedSolo = await renderProjectWithEngine(
      mutedSoloDoc,
      renderOptions(new AudibilityEngine()),
    );
    expect(mutedSolo.channels[0][0]).toBeCloseTo(0, 5);
    expect(mutedSolo.channels[0][2 * SAMPLES_PER_PPQ]).toBeCloseTo(0, 5);

    const mutedSoloSafeDoc = makeDoc();
    mutedSoloSafeDoc.tracks[0].soloSafe = true;
    mutedSoloSafeDoc.tracks[0].mute = true;
    mutedSoloSafeDoc.tracks[1].solo = true;
    const mutedSoloSafe = await renderProjectWithEngine(
      mutedSoloSafeDoc,
      renderOptions(new AudibilityEngine()),
    );
    expect(mutedSoloSafe.channels[0][0]).toBeCloseTo(0, 5);
    expect(mutedSoloSafe.channels[0][2 * SAMPLES_PER_PPQ]).toBeGreaterThan(0);
  });

  it('replays lanes, buses, sends, params, automation and clips onto the engine', async () => {
    const engine = new FakeEngine();
    const result = await renderProjectWithEngine(makeDoc(), renderOptions(engine));

    // Lanes with synthetic ids; the audio track's send maps to engine bus 1.
    expect(engine.named('setTrackLanes')[0][1]).toEqual([
      { trackId: 1 },
      { trackId: 2, sends: [{ busId: 1, levelDb: -9, enabled: true }] },
    ]);
    expect(engine.named('setTrackBuses')[0][1]).toEqual([{ busId: 1, gainDb: -6 }]);

    // Lane base parameters mirror the live mixer-sync derivation.
    const params = new Map(engine.named('setParameter').map(([, id, value]) => [id, value]));
    expect(params.get(0x4d580001)).toBeCloseTo(linearToDb(0.5), 5);
    expect(params.get(0x4d580101)).toBeCloseTo(linearToDb(1) + 2, 5);
    expect(params.get(0x4d580102)).toBeCloseTo(-0.25, 5);
    expect(params.get(0x4d58ff01)).toBeCloseTo(-3, 5);
    expect(params.get(0x4d58ff02)).toBeCloseTo(0.5, 5);

    // Automation: enabled lanes only, engine curve codes applied.
    const lanes = new Map(engine.named('setAutomationLane').map(([, id, points]) => [id, points]));
    expect(lanes.get(0x4d580001)).toEqual([
      { ppq: 0, value: -24, curveToNext: 0 },
      { ppq: 4, value: 0, curveToNext: 2 },
    ]);
    expect(lanes.get(0x4d58ff02)).toEqual([{ ppq: 1, value: -1, curveToNext: 0 }]);
    expect(lanes.has(0x4d58ff01)).toBe(false);

    // Instruments and MIDI schedules reach the engine.
    expect(engine.named('setSynthInstrument')[0]).toEqual([
      'setSynthInstrument',
      'acoustic-piano',
      1,
    ]);
    const midi = engine.named('setMidiClips')[0][1] as unknown[];
    expect(midi.length).toBe(1);

    // The audio clip is placed at its timeline PPQ with the clip gain only.
    const clips = engine.named('setClips')[0][1] as Array<Record<string, unknown>>;
    expect(clips).toHaveLength(1);
    expect(clips[0].trackId).toBe(2);
    expect(clips[0].startPpq).toBe(2);
    expect(clips[0].gain).toBeCloseTo(0.8, 5);

    // 'project' range: content ends at ppq 4 (= 2 s at 120 BPM) + 2 s tail.
    expect(result.totalFrames).toBe(4 * 24000 + 2 * 48000);
    expect(result.channels[0][0]).toBeCloseTo(0.25, 5);
    expect(result.report.peakDb).toBeCloseTo(20 * Math.log10(0.25), 3);
    expect(engine.named('seekSample')[0][1]).toBe(0);
    expect(engine.destroyed).toBe(true);
  });

  it('applies a legacy non-center document pan to the exported lane', async () => {
    const doc = makeDoc();
    doc.tracks[0].pan = 0.75;
    delete doc.tracks[0].mixer;
    const engine = new FakeEngine();

    await renderProjectWithEngine(doc, renderOptions(engine));

    const params = new Map(engine.named('setParameter').map(([, id, value]) => [id, value]));
    expect(params.get(0x4d580002)).toBe(0.75);
  });

  it('allows project renders to override the release tail length', async () => {
    const engine = new FakeEngine();
    const result = await renderProjectWithEngine(makeDoc(), {
      ...renderOptions(engine),
      releaseTailSeconds: 5,
    });

    // Content ends at ppq 4 (= 2 s at 120 BPM); the caller can extend the tail
    // for long reverb/delay releases without changing explicit range renders.
    expect(result.totalFrames).toBe(4 * 24000 + 5 * 48000);
  });

  it('routes a track output bus into its lane descriptor', async () => {
    const doc = makeDoc();
    // Route the Keys track (engine track 1) into bus 'bus-a' (engine bus 1).
    (doc.tracks[0] as { mixer?: Record<string, unknown> }).mixer = {
      gainDb: 0,
      pan: 0,
      inserts: [],
      sends: [],
      outputBusId: 'bus-a',
    };
    const engine = new FakeEngine();
    await renderProjectWithEngine(doc, renderOptions(engine));

    expect(engine.named('setTrackLanes')[0][1]).toEqual([
      { trackId: 1, outputBusId: 1 },
      { trackId: 2, sends: [{ busId: 1, levelDb: -9, enabled: true }] },
    ]);
  });

  it('injects the expression map of a track into the exported schedule', async () => {
    const doc = makeDoc();
    doc.tracks[0].expressionMap = { entries: [{ articulation: 'staccato', keySwitch: 24 }] };
    doc.tracks[0].clips[0].scoreAnnotations = [
      { pitch: 60, startPpq: 0, channel: 0, articulation: 'staccato' },
    ];
    const engine = new FakeEngine();
    await renderProjectWithEngine(doc, renderOptions(engine));

    const schedules = engine.named('setMidiClips')[0][1] as Array<{
      events: Array<{ renderFrame: number; word0: number }>;
    }>;
    const events = schedules.flatMap((schedule) => schedule.events);
    const keySwitchOn = events.find(
      (event) => ((event.word0 >>> 16) & 0xf0) === 0x90 && ((event.word0 >>> 8) & 0x7f) === 24,
    );
    const noteOn = events.find(
      (event) => ((event.word0 >>> 16) & 0xf0) === 0x90 && ((event.word0 >>> 8) & 0x7f) === 60,
    );

    expect(keySwitchOn).toBeDefined();
    expect(keySwitchOn?.renderFrame).toBeLessThan(noteOn?.renderFrame ?? 0);
  });

  it('exports a soloed return the way it auditions', async () => {
    const doc = makeDoc();
    const buses = doc.mixer?.buses as Array<Record<string, unknown>>;
    buses[0].solo = true;
    const engine = new FakeEngine();
    await renderProjectWithEngine(doc, renderOptions(engine));

    // Bus 1 is the soloed return; bus 2 is the silent bus the direct outputs
    // are parked on, so only the send-fed return reaches the master.
    expect(engine.named('setTrackBuses')[0][1]).toEqual([
      { busId: 1, gainDb: -6 },
      { busId: 2, gainDb: -120 },
    ]);
    expect(engine.named('setTrackLanes')[0][1]).toEqual([
      { trackId: 1, outputBusId: 2 },
      { trackId: 2, sends: [{ busId: 1, levelDb: -9, enabled: true }], outputBusId: 2 },
    ]);
  });

  it('preserves MIDI performance lanes from document clips in offline schedules', async () => {
    const doc = makeDoc();
    const clip = doc.tracks[0].clips[0];
    clip.notes = [];
    clip.ccLanes = [{ controller: 11, channel: 2, points: [{ ppq: 0.5, value: 96 }] }];
    clip.pitchBendLanes = [{ channel: 2, points: [{ ppq: 1, value: 4096 }] }];
    clip.programChangeLanes = [{ channel: 2, points: [{ ppq: 1.25, program: 12 }] }];
    clip.channelPressureLanes = [{ channel: 2, points: [{ ppq: 1.5, value: 70 }] }];
    clip.polyPressureLanes = [{ channel: 2, pitch: 64, points: [{ ppq: 2, value: 80 }] }];

    const engine = new FakeEngine();
    await renderProjectWithEngine(doc, renderOptions(engine));

    const midi = engine.named('setMidiClips')[0][1] as Array<{
      events: Array<{ renderFrame: number; word0: number; wordCount: number }>;
    }>;
    expect(midi).toHaveLength(1);
    expect(midi[0].events).toEqual([
      { renderFrame: 12000, word0: ccWord(2, 11, 96), wordCount: 1 },
      { renderFrame: 24000, word0: pitchBendWord(2, 4096), wordCount: 1 },
      { renderFrame: 30000, word0: pcWord(2, 12), wordCount: 1 },
      { renderFrame: 36000, word0: channelPressureWord(2, 70), wordCount: 1 },
      { renderFrame: 48000, word0: polyPressureWord(2, 64, 80), wordCount: 1 },
    ]);
  });

  it('keeps MIDI performance-only clips audibly silent', async () => {
    const doc = makeDoc();
    doc.tracks[1].mute = true;
    const clip = doc.tracks[0].clips[0];
    clip.notes = [];
    clip.ccLanes = [{ controller: 11, channel: 0, points: [{ ppq: 0, value: 96 }] }];
    clip.pitchBendLanes = [{ channel: 0, points: [{ ppq: 1, value: 4096 }] }];
    clip.programChangeLanes = [{ channel: 0, points: [{ ppq: 1.5, program: 12 }] }];
    clip.channelPressureLanes = [{ channel: 0, points: [{ ppq: 2, value: 70 }] }];
    clip.polyPressureLanes = [{ channel: 0, pitch: 64, points: [{ ppq: 3, value: 80 }] }];
    const engine = new AudibilityEngine();

    const result = await renderProjectWithEngine(doc, renderOptions(engine));

    expect(engine.named('setMidiClips')).toHaveLength(1);
    expect(result.channels[0][0]).toBeCloseTo(0, 5);
    expect(result.channels[0][SAMPLES_PER_PPQ]).toBeCloseTo(0, 5);
    expect(result.channels[0][2 * SAMPLES_PER_PPQ]).toBeCloseTo(0, 5);
    expect(result.channels[0][3 * SAMPLES_PER_PPQ]).toBeCloseTo(0, 5);
  });

  it('keeps gain-zero MIDI notes silent while preserving controller schedules', async () => {
    const doc = makeDoc();
    doc.tracks[1].mute = true;
    const clip = doc.tracks[0].clips[0];
    clip.gain = 0;
    clip.notes = [{ pitch: 60, velocity: 127, startPpq: 0, durationPpq: 1, channel: 0 }];
    clip.ccLanes = [{ controller: 11, channel: 0, points: [{ ppq: 0, value: 96 }] }];
    const engine = new AudibilityEngine();

    const result = await renderProjectWithEngine(doc, renderOptions(engine));
    const midi = engine.named('setMidiClips')[0][1] as Array<{
      events: Array<{ word0: number }>;
    }>;

    expect(midi[0].events.map((event) => midiStatus(event.word0))).toEqual([0xb]);
    expect(result.channels[0][0]).toBeCloseTo(0, 5);
    expect(result.channels[0][SAMPLES_PER_PPQ - 2]).toBeCloseTo(0, 5);
  });

  it('renders MIDI clips from the source-offset note window', async () => {
    const doc = makeDoc();
    const clip = doc.tracks[0].clips[0];
    clip.startPpq = 1;
    clip.sourceOffsetPpq = 2;
    clip.lengthPpq = 2;
    clip.notes = [
      { pitch: 60, velocity: 100, startPpq: 1, durationPpq: 1, channel: 0 },
      { pitch: 67, velocity: 90, offVelocity: 32, startPpq: 2, durationPpq: 1, channel: 1 },
      { pitch: 69, velocity: 80, startPpq: 3, durationPpq: 1, channel: 1 },
      { pitch: 71, velocity: 70, startPpq: 4, durationPpq: 1, channel: 1 },
    ];

    const engine = new FakeEngine();
    await renderProjectWithEngine(doc, renderOptions(engine));

    const midi = engine.named('setMidiClips')[0][1] as Array<{
      startSample: number;
      lengthSamples: number;
      events: Array<{ renderFrame: number; word0: number; wordCount: number }>;
    }>;
    expect(midi).toHaveLength(1);
    expect(midi[0].startSample).toBe(24000);
    expect(midi[0].lengthSamples).toBe(48000);
    expect(midi[0].events).toEqual([
      { renderFrame: 24000, word0: noteOnWord(1, 67, 90), wordCount: 1 },
      { renderFrame: 47999, word0: noteOffWord(1, 67, 32), wordCount: 1 },
      { renderFrame: 48000, word0: noteOnWord(1, 69, 80), wordCount: 1 },
      { renderFrame: 71999, word0: noteOffWord(1, 69), wordCount: 1 },
    ]);
  });

  it('loads and binds SF2 instruments for offline MIDI playback', async () => {
    const doc = makeDoc();
    doc.tracks[0].instrument = { kind: 'sf2', fontId: 'font-a', bank: 130, program: 5 };
    const fontBytes = new Uint8Array([1, 2, 3]);
    const loadFont = vi.fn(async () => fontBytes);
    const engine = new FakeEngine();

    await renderProjectWithEngine(doc, { ...renderOptions(engine), loadFont });

    expect(loadFont).toHaveBeenCalledTimes(1);
    expect(loadFont).toHaveBeenCalledWith('font-a');
    expect(engine.named('loadSoundFont')).toEqual([['loadSoundFont', fontBytes]]);
    expect(engine.named('setSf2Instrument')).toEqual([['setSf2Instrument', {}, 1]]);
    expect(engine.named('setSynthInstrument')).toEqual([]);

    const midi = engine.named('setMidiClips')[0][1] as Array<{
      events: Array<{ renderFrame: number; word0: number; wordCount: number }>;
    }>;
    expect(midi[0].events.slice(0, 3)).toEqual([
      { renderFrame: 0, word0: ccWord(0, 0, 1), wordCount: 1 },
      { renderFrame: 0, word0: ccWord(0, 32, 2), wordCount: 1 },
      { renderFrame: 0, word0: pcWord(0, 5), wordCount: 1 },
    ]);
    // The clip starts at frame 0, so its note-on is shifted after the prelude.
    expect(midi[0].events[3]).toEqual({
      renderFrame: 1,
      word0: noteOnWord(0, 60, 96),
      wordCount: 1,
    });
  });

  it('applies complete setup GS SysEx after binding SF2 and before MIDI playback', async () => {
    const doc = makeDoc();
    doc.tracks[0].instrument = { kind: 'sf2', fontId: 'font-a' };
    doc.tracks[0].clips[0].smfSysEx = [
      {
        ppq: 0,
        status: 0xf0,
        data: [0x41, 0x10, 0x42, 0x12, 0x40, 0x03, 0x00, 0x01, 0x10, 0x2c, 0xf7],
      },
    ];
    const engine = new FakeEngine();

    await renderProjectWithEngine(doc, {
      ...renderOptions(engine),
      loadFont: async () => new Uint8Array([1, 2, 3]),
    });

    expect(engine.named('pushMidiSysex')).toEqual([
      [
        'pushMidiSysex',
        1,
        Uint8Array.from([0xf0, 0x41, 0x10, 0x42, 0x12, 0x40, 0x03, 0x00, 0x01, 0x10, 0x2c, 0xf7]),
        -1,
      ],
    ]);
    const bindIndex = engine.calls.findIndex(([name]) => name === 'setSf2Instrument');
    const sysexIndex = engine.calls.findIndex(([name]) => name === 'pushMidiSysex');
    const scheduleIndex = engine.calls.findIndex(([name]) => name === 'setMidiClips');
    expect(bindIndex).toBeGreaterThanOrEqual(0);
    expect(sysexIndex).toBeGreaterThan(bindIndex);
    expect(scheduleIndex).toBeGreaterThan(sysexIndex);
  });

  it('fans setup GS SysEx only to selected SF2 pre-render passes', async () => {
    const doc = makeDoc();
    doc.tracks[1].mute = true;
    doc.tracks[0].instrument = { kind: 'sf2', fontId: 'font-a' };
    doc.tracks[0].clips[0].smfSysEx = [
      {
        ppq: 0,
        status: 0xf0,
        data: [0x41, 0x10, 0x42, 0x12, 0x40, 0x03, 0x00, 0x01, 0x10, 0x2c, 0xf7],
      },
    ];
    doc.tracks.push({
      name: 'Brass',
      color: '#fc0',
      kind: 'midi',
      mute: false,
      solo: false,
      volume: 1,
      pan: 0,
      instrument: { kind: 'sf2', fontId: 'font-b' },
      clips: [structuredClone(doc.tracks[0].clips[0])],
    } as (typeof doc.tracks)[number]);
    const engines: FakeEngine[] = [];
    await renderProjectWithEngine(doc, {
      ...renderOptions(new FakeEngine()),
      createEngine: () => {
        const engine = new FakeEngine();
        engines.push(engine);
        return engine;
      },
      loadFont: async (fontId) => new Uint8Array([fontId === 'font-a' ? 1 : 2]),
    });

    expect(engines).toHaveLength(3);
    expect(engines[0].named('pushMidiSysex').map(([, data]) => data)).toHaveLength(1);
    expect(engines[0].named('pushMidiSysex')[0][1]).toBe(1);
    expect(engines[1].named('pushMidiSysex').map(([, data]) => data)).toHaveLength(1);
    expect(engines[1].named('pushMidiSysex')[0][1]).toBe(3);
    expect(engines[2].named('pushMidiSysex')).toEqual([]);
  });

  it('keeps project-inherited external MIDI tracks out of the offline synth renderer', async () => {
    const doc = makeDoc();
    doc.tracks[0].externalMidiMode = 'project';
    doc.externalMidiDefault = { kind: 'external-midi', outputPortId: 'port-a', channel: 0 };

    const engine = new FakeEngine();
    await renderProjectWithEngine(doc, renderOptions(engine));

    expect(engine.named('setSynthInstrument')).toEqual([]);
    expect(engine.named('setMidiClips')).toEqual([]);
  });

  it('does not load or bind an SF2 for empty, muted, or range-excluded MIDI', async () => {
    for (const scenario of ['empty', 'muted', 'outside'] as const) {
      const doc = makeDoc();
      doc.tracks[1].mute = true;
      doc.tracks[0].instrument = { kind: 'sf2', fontId: `font-${scenario}` };
      if (scenario === 'empty') doc.tracks[0].clips[0].notes = [];
      if (scenario === 'muted') doc.tracks[0].mute = true;
      const loadFont = vi.fn(async () => new Uint8Array([1]));
      const engine = new FakeEngine();

      await renderProjectWithEngine(doc, {
        ...renderOptions(engine),
        ...(scenario === 'outside' ? { range: { startPpq: 2, endPpq: 3 } as const } : {}),
        loadFont,
      });

      expect(loadFont, scenario).not.toHaveBeenCalled();
      expect(engine.named('loadSoundFont'), scenario).toEqual([]);
      expect(engine.named('setSf2Instrument'), scenario).toEqual([]);
    }
  });

  it('loads an SF2 for MIDI contributing only through the stateful preroll', async () => {
    const doc = makeDoc();
    doc.tracks[1].mute = true;
    doc.tracks[0].instrument = { kind: 'sf2', fontId: 'font-preroll' };
    doc.tracks[0].clips[0].notes = [
      { pitch: 60, velocity: 96, startPpq: 1, durationPpq: 0.5, channel: 0 },
    ];
    doc.mixer!.master.inserts = [
      { processor: 'reverb.algorithmic', params: { decaySeconds: 5 }, enabled: true },
    ];
    const fontBytes = new Uint8Array([7]);
    const loadFont = vi.fn(async () => fontBytes);
    const engine = new FakeEngine();

    await renderProjectWithEngine(doc, {
      ...renderOptions(engine),
      range: { startPpq: 4, endPpq: 5 },
      insertTail: () => 5,
      loadFont,
    });

    expect(loadFont).toHaveBeenCalledWith('font-preroll');
    expect(engine.named('loadSoundFont')).toEqual([['loadSoundFont', fontBytes]]);
    expect(engine.named('setSf2Instrument')).toEqual([['setSf2Instrument', {}, 1]]);
    expect(engine.named('seekSample')[0][1]).toBe(0);
  });

  it('does not create false SF2 conflict passes from a muted font', async () => {
    const doc = makeDoc();
    doc.tracks[1].mute = true;
    doc.tracks[0].instrument = { kind: 'sf2', fontId: 'font-a' };
    doc.tracks.push({
      name: 'Muted brass',
      color: '#fc0',
      kind: 'midi',
      mute: true,
      solo: false,
      volume: 1,
      pan: 0,
      instrument: { kind: 'sf2', fontId: 'font-b' },
      clips: [
        {
          name: 'brass',
          startPpq: 0,
          lengthPpq: 1,
          sourceOffsetPpq: 0,
          gain: 1,
          loopEnabled: false,
          loopLengthPpq: 0,
          notes: [{ pitch: 67, velocity: 80, startPpq: 0, durationPpq: 1, channel: 0 }],
        },
      ],
    } as (typeof doc.tracks)[number]);
    const loadFont = vi.fn(async (fontId: string) =>
      fontId === 'font-a' ? new Uint8Array([1]) : new Uint8Array([2]),
    );
    const engines: FakeEngine[] = [];

    await renderProjectWithEngine(doc, {
      ...renderOptions(new FakeEngine()),
      createEngine: () => {
        const engine = new FakeEngine();
        engines.push(engine);
        return engine;
      },
      loadFont,
    });

    expect(loadFont.mock.calls.map(([fontId]) => fontId)).toEqual(['font-a']);
    expect(engines).toHaveLength(1);
  });

  it('rejects cross-font SF2 key rendering before an isolated bounce can lose the key', async () => {
    const doc = makeDoc();
    doc.tracks[0].instrument = { kind: 'sf2', fontId: 'font-a' };
    doc.tracks[1].kind = 'midi';
    doc.tracks[1].instrument = { kind: 'sf2', fontId: 'font-b' };
    doc.tracks[1].clips = structuredClone(doc.tracks[0].clips);
    doc.tracks[0].mixer = {
      gainDb: 0,
      pan: 0,
      sends: [],
      inserts: [
        {
          processor: 'dynamics.compressor',
          params: {},
          enabled: true,
          sidechainSourceIndex: 1,
        } as InsertSlot,
      ],
    };

    await expect(
      renderProjectWithEngine(doc, {
        ...renderOptions(new FakeEngine()),
        loadFont: async () => new Uint8Array([1]),
      }),
    ).rejects.toThrow(/conflicting fonts/);
  });

  it('allows a master key when conflicting SoundFonts are pre-rendered before the final pass', async () => {
    const doc = makeDoc();
    doc.tracks[0].instrument = { kind: 'sf2', fontId: 'font-a' };
    doc.tracks[1].kind = 'midi';
    doc.tracks[1].instrument = { kind: 'sf2', fontId: 'font-b' };
    doc.tracks[1].clips = structuredClone(doc.tracks[0].clips);
    doc.mixer!.master.inserts.push({
      processor: 'dynamics.compressor',
      params: {},
      enabled: true,
      sidechainSourceIndex: 0,
    } as InsertSlot);

    await expect(
      renderProjectWithEngine(doc, {
        ...renderOptions(new FakeEngine()),
        loadFont: async () => new Uint8Array([1]),
      }),
    ).resolves.toBeDefined();
  });

  it('binds synth patch instruments before audible MIDI playback', async () => {
    const doc = makeDoc();
    doc.tracks[1].mute = true;
    const patch = { preset: 'saw-lead', cutoffHz: 800 };
    doc.tracks[0].instrument = { kind: 'synth-patch', patch };
    const engine = new AudibilityEngine();

    const result = await renderProjectWithEngine(doc, renderOptions(engine));

    expect(engine.named('setSynthInstrument')).toEqual([['setSynthInstrument', patch, 1]]);
    expect(result.channels[0][0]).toBeCloseTo(defaultMidiLevel(96), 5);
  });

  it('binds GM-enabled synth presets and schedules their initial selection offline', async () => {
    const doc = makeDoc();
    doc.tracks[1].mute = true;
    doc.tracks[0].instrument = {
      kind: 'synth-preset',
      preset: 'saw-lead',
      useGmPrograms: true,
      gmBank: 128,
      gmProgram: 25,
    };
    const engine = new FakeEngine();

    await renderProjectWithEngine(doc, renderOptions(engine));

    expect(engine.named('setSynthInstrument')).toEqual([
      ['setSynthInstrument', { preset: 'saw-lead', useGmPrograms: true }, 1],
    ]);
    const midi = engine.named('setMidiClips')[0][1] as Array<{
      events: Array<{ renderFrame: number; word0: number; wordCount: number }>;
    }>;
    expect(midi[0].events.slice(0, 3)).toEqual([
      { renderFrame: 0, word0: ccWord(0, 0, 1), wordCount: 1 },
      { renderFrame: 0, word0: ccWord(0, 32, 0), wordCount: 1 },
      { renderFrame: 0, word0: pcWord(0, 25), wordCount: 1 },
    ]);
    expect(midi[0].events[3]).toEqual({
      renderFrame: 1,
      word0: noteOnWord(0, 60, 96),
      wordCount: 1,
    });
  });

  it('drives synth-patch instrument lanes on the bound instrument during offline playback', async () => {
    const doc = makeDoc();
    doc.tracks[1].mute = true;
    doc.tracks[0].instrument = {
      kind: 'synth-patch',
      patch: { preset: 'saw-lead', cutoffHz: 800, drive: 0.2 },
    };
    doc.tracks[0].automation = [
      {
        param: instrumentAutomationParam('cutoffHz'),
        enabled: true,
        points: [
          { ppq: 0, value: 1200 },
          { ppq: 8, value: 2400 },
        ],
      },
      {
        param: instrumentAutomationParam('drive'),
        enabled: false,
        points: [{ ppq: 0, value: 0.9 }],
      },
    ];
    const engine = new AudibilityEngine();

    const result = await renderProjectWithEngine(doc, renderOptions(engine));

    expect(engine.named('setSynthInstrument')).toEqual([
      ['setSynthInstrument', { preset: 'saw-lead', cutoffHz: 800, drive: 0.2 }, 1],
    ]);
    // Resolved against the instrument just bound; the disabled lane is never resolved.
    expect(engine.named('resolveInstrumentAutomationId')).toEqual([
      ['resolveInstrumentAutomationId', 1, 'cutoffHz'],
    ]);
    const bindIndex = engine.calls.findIndex(([name]) => name === 'setSynthInstrument');
    const resolveIndex = engine.calls.findIndex(
      ([name]) => name === 'resolveInstrumentAutomationId',
    );
    expect(resolveIndex).toBeGreaterThan(bindIndex);
    const instrumentLaneId = (0xc0000000 | (1 << 8)) >>> 0;
    const lane = engine
      .named('setAutomationLane')
      .find(([, paramId]) => paramId === instrumentLaneId);
    expect(lane?.[2]).toEqual([
      expect.objectContaining({ ppq: 0, value: 1200 }),
      expect.objectContaining({ ppq: 8, value: 2400 }),
    ]);
    expect(result.report.limitations).toBeUndefined();
  });

  it('reports same-PPQ value changes as a start-value limitation while rendering the first value', async () => {
    const masteringPoints = [
      { ppq: 0, value: -6 },
      { ppq: 0, value: -3 },
    ];
    const doc = makeDoc();
    doc.tracks[1].mute = true;
    doc.mixer = {
      ...doc.mixer,
      masteringChain: {
        processors: [
          { processor: 'maximizer.truePeakLimiter', params: { ceilingDb: -1 }, enabled: true },
        ],
      },
    };
    doc.masterAutomation = [
      {
        param: masteringAutomationParam(0, 'ceilingDb'),
        enabled: true,
        points: masteringPoints,
      },
    ];
    const processStereo = vi.fn((_name: string, left: Float32Array, right: Float32Array) => ({
      left,
      right,
    }));
    const engine = new AudibilityEngine();

    const result = await renderProjectWithEngine(doc, {
      ...renderOptions(engine),
      deps: { mastering: { processStereo }, metering: null },
    });

    expect(offlineAutomationLimitations(doc)).toEqual([
      { kind: 'mastering-automation-at-render-start' },
    ]);
    expect(result.report.limitations).toEqual([
      {
        kind: 'mastering-automation-at-render-start',
        params: ['maximizer.truePeakLimiter.ceilingDb'],
      },
    ]);
    expect(processStereo).toHaveBeenCalledWith(
      'maximizer.truePeakLimiter',
      expect.any(Float32Array),
      expect.any(Float32Array),
      48000,
      { ceilingDb: -6 },
    );
  });

  it('does not report a limitation for equal-valued points at different PPQs', () => {
    const doc = makeDoc();
    doc.tracks[0].instrument = {
      kind: 'synth-patch',
      patch: { preset: 'saw-lead', cutoffHz: 800 },
    };
    doc.tracks[0].automation = [
      {
        param: instrumentAutomationParam('cutoffHz'),
        enabled: true,
        points: [
          { ppq: 0, value: 1200 },
          { ppq: 8, value: 1200 },
        ],
      },
    ];
    doc.mixer = {
      ...doc.mixer,
      masteringChain: {
        processors: [
          { processor: 'maximizer.truePeakLimiter', params: { ceilingDb: -1 }, enabled: true },
        ],
      },
    };
    doc.masterAutomation = [
      {
        param: masteringAutomationParam(0, 'ceilingDb'),
        enabled: true,
        points: [
          { ppq: 0, value: -6 },
          { ppq: 8, value: -6 },
        ],
      },
    ];

    expect(offlineAutomationLimitations(doc)).toEqual([]);
  });

  it('loads SF2 instruments before audible MIDI playback', async () => {
    const doc = makeDoc();
    doc.tracks[1].mute = true;
    doc.tracks[0].instrument = { kind: 'sf2', fontId: 'font-a', bank: 130, program: 5 };
    const fontBytes = new Uint8Array([1, 2, 3]);
    const engine = new AudibilityEngine();

    const result = await renderProjectWithEngine(doc, {
      ...renderOptions(engine),
      loadFont: async () => fontBytes,
    });

    expect(engine.named('loadSoundFont')).toEqual([['loadSoundFont', fontBytes]]);
    expect(engine.named('setSf2Instrument')).toEqual([['setSf2Instrument', {}, 1]]);
    expect(result.channels[0][0]).toBeCloseTo(0, 5);
    expect(result.channels[0][1]).toBeCloseTo(defaultMidiLevel(96), 5);
  });

  it('renders conflicting SF2 tracks in font-fixed pre-fader passes', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const doc = makeDoc();
      doc.tracks[1].mute = true;
      doc.tracks[0].instrument = { kind: 'sf2', fontId: 'font-a' };
      (doc.mixer as NonNullable<ProjectDocument['mixer']>).master.inserts = [
        { processor: 'dynamics.limiter', params: {}, enabled: true },
      ];
      doc.tracks.push({
        name: 'Brass',
        color: '#fc0',
        kind: 'midi',
        mute: false,
        solo: false,
        volume: 1,
        pan: 0,
        instrument: { kind: 'sf2', fontId: 'font-b' },
        clips: [
          {
            name: 'brass',
            startPpq: 0,
            lengthPpq: 1,
            sourceOffsetPpq: 0,
            gain: 1,
            loopEnabled: false,
            loopLengthPpq: 0,
            notes: [{ pitch: 67, velocity: 80, startPpq: 0, durationPpq: 1, channel: 0 }],
          },
        ],
      } as (typeof doc.tracks)[number]);
      doc.tracks.push({
        name: 'Frozen Strings',
        color: '#8cf',
        kind: 'midi',
        mute: false,
        solo: false,
        volume: 1,
        pan: 0,
        instrument: { kind: 'sf2', fontId: 'font-c' },
        frozen: { assetId: 'frozen-strings' },
        clips: [],
      } as (typeof doc.tracks)[number]);
      const bytesById = new Map([
        ['font-a', new Uint8Array([1])],
        ['font-b', new Uint8Array([2])],
        ['font-c', new Uint8Array([3])],
      ]);
      const loadFont = vi.fn(async (fontId: string) => bytesById.get(fontId) ?? new Uint8Array());
      const engines: FakeEngine[] = [];

      await renderProjectWithEngine(doc, {
        deps: null,
        createEngine: () => {
          const engine = new FakeEngine();
          engines.push(engine);
          return engine;
        },
        loadAudioAsset: async () => fakeAsset(),
        loadFont,
      });

      expect(warn).not.toHaveBeenCalled();
      expect(loadFont.mock.calls.map(([fontId]) => fontId)).toEqual(['font-a', 'font-b']);
      expect(engines).toHaveLength(3);
      expect(engines[0].named('loadSoundFont')).toEqual([
        ['loadSoundFont', bytesById.get('font-a')],
      ]);
      expect(engines[0].named('setSf2Instrument')).toEqual([['setSf2Instrument', {}, 1]]);
      expect(engines[1].named('loadSoundFont')).toEqual([
        ['loadSoundFont', bytesById.get('font-b')],
      ]);
      expect(engines[1].named('setSf2Instrument')).toEqual([['setSf2Instrument', {}, 3]]);
      expect(engines[2].named('loadSoundFont')).toEqual([]);
      expect(engines[2].named('setSf2Instrument')).toEqual([]);
      expect(engines[2].named('setMidiClips')).toEqual([]);
      expect(engines[0].named('setMasterStripJson')).toEqual([]);
      expect(engines[1].named('setMasterStripJson')).toEqual([]);
      expect(engines[2].named('setMasterStripJson')).toHaveLength(1);
      const finalClips = engines[2].named('setClips')[0][1] as Array<{ trackId: number }>;
      expect(finalClips.slice(-2).map((clip) => clip.trackId)).toEqual([1, 3]);
    } finally {
      warn.mockRestore();
    }
  });

  it('mixes each conflicting SF2 track with its own font before the master pass', async () => {
    const doc = makeDoc();
    doc.tracks[1].mute = true;
    doc.tracks[0].instrument = { kind: 'sf2', fontId: 'font-a' };
    doc.tracks.push({
      name: 'Brass',
      color: '#fc0',
      kind: 'midi',
      mute: false,
      solo: false,
      volume: 1,
      pan: 0,
      instrument: { kind: 'sf2', fontId: 'font-b' },
      clips: [
        {
          name: 'brass',
          startPpq: 0,
          lengthPpq: 1,
          sourceOffsetPpq: 0,
          gain: 1,
          loopEnabled: false,
          loopLengthPpq: 0,
          notes: [{ pitch: 67, velocity: 80, startPpq: 0, durationPpq: 1, channel: 0 }],
        },
      ],
    } as (typeof doc.tracks)[number]);
    const bytesById = new Map([
      ['font-a', new Uint8Array([20])],
      ['font-b', new Uint8Array([70])],
    ]);
    const engines: SoundFontAudibilityEngine[] = [];

    const result = await renderProjectWithEngine(doc, {
      deps: null,
      createEngine: () => {
        const engine = new SoundFontAudibilityEngine();
        engines.push(engine);
        return engine;
      },
      loadAudioAsset: async () => fakeAsset(),
      loadFont: async (fontId) => bytesById.get(fontId) ?? new Uint8Array(),
    });

    const expectedKeys = midiAmplitude(96) * 0.2 * defaultMidiLaneGain();
    const expectedBrass = midiAmplitude(80) * 0.7;
    expect(result.channels[0][1]).toBeCloseTo(
      (expectedKeys + expectedBrass) * defaultMasterGain(),
      5,
    );
    expect(engines).toHaveLength(3);
    expect(engines[2].named('loadSoundFont')).toEqual([]);
    expect(engines[2].named('setSf2Instrument')).toEqual([]);
  });

  it('renders multiple MIDI instruments on separate destinations and stems', async () => {
    const doc = makeDoc();
    doc.tracks[1].mute = true;
    doc.tracks[0].automation = [];
    doc.tracks[0].volume = 1;
    doc.tracks[0].instrument = { kind: 'synth-preset', preset: 'e-piano' };
    doc.tracks[0].clips[0].notes = [
      { pitch: 60, velocity: 64, startPpq: 0, durationPpq: 1, channel: 0 },
    ];
    doc.tracks.push({
      name: 'Lead',
      color: '#f0a',
      kind: 'midi',
      mute: false,
      solo: false,
      volume: 0.25,
      pan: 0,
      instrument: { kind: 'synth-patch', patch: { preset: 'saw-lead', cutoffHz: 1200 } },
      clips: [
        {
          name: 'lead',
          startPpq: 0,
          lengthPpq: 1,
          sourceOffsetPpq: 0,
          gain: 1,
          loopEnabled: false,
          loopLengthPpq: 0,
          notes: [{ pitch: 72, velocity: 96, startPpq: 0, durationPpq: 1, channel: 0 }],
        },
      ],
    } as (typeof doc.tracks)[number]);
    const engines: AudibilityEngine[] = [];
    const result = await renderProjectWithEngine(doc, {
      deps: null,
      loadAudioAsset: async () => fakeAsset(),
      createEngine: () => {
        const engine = new AudibilityEngine();
        engines.push(engine);
        return engine;
      },
      stems: true,
    });
    const leadGain = dbGain(linearToDb(0.25));
    const instrumentCalls = engines.flatMap((engine) => engine.named('setSynthInstrument'));

    expect(instrumentCalls).toEqual([
      ['setSynthInstrument', 'e-piano', 1],
      ['setSynthInstrument', { preset: 'saw-lead', cutoffHz: 1200 }, 3],
      ['setSynthInstrument', 'e-piano', 1],
      ['setSynthInstrument', { preset: 'saw-lead', cutoffHz: 1200 }, 3],
      ['setSynthInstrument', 'e-piano', 1],
      ['setSynthInstrument', { preset: 'saw-lead', cutoffHz: 1200 }, 3],
    ]);
    expect(result.channels[0][0]).toBeCloseTo(
      (midiAmplitude(64) + midiAmplitude(96) * leadGain) * defaultMasterGain(),
      5,
    );
    expect(result.stems?.find((stem) => stem.name === 'Keys')?.channels[0][0]).toBeCloseTo(
      midiAmplitude(64),
      5,
    );
    expect(result.stems?.find((stem) => stem.name === 'Lead')?.channels[0][0]).toBeCloseTo(
      midiAmplitude(96) * leadGain,
      5,
    );
  });

  it('renders an explicit window with a pre-roll before its start', async () => {
    const engine = new FakeEngine();
    const result = await renderProjectWithEngine(makeDoc(), {
      ...renderOptions(engine),
      range: { startPpq: 1, endPpq: 3 },
    });
    // The window starts at sample 24000; the render seeks half a second
    // earlier (clamped at the timeline start) and discards the pre-roll so
    // stateful DSP is already in motion at the capture start.
    expect(engine.named('seekSample')[0][1]).toBe(0);
    expect(result.totalFrames).toBe(2 * 24000);
  });

  it('settles engine parameters before playback reaches the captured window', async () => {
    const engine = new FakeEngine();
    await renderProjectWithEngine(makeDoc(), {
      ...renderOptions(engine),
      range: { startPpq: 2, endPpq: 3 },
    });

    const callNames = engine.calls.map(([name]) => name);
    const seekIndex = callNames.indexOf('seekSample');
    const firstProcessIndex = callNames.indexOf('process');
    const settleIndex = callNames.indexOf('settleParameters');
    const playIndex = callNames.indexOf('play');

    expect(engine.named('seekSample')[0][1]).toBe(SAMPLES_PER_PPQ);
    expect(seekIndex).toBeLessThan(firstProcessIndex);
    expect(firstProcessIndex).toBeLessThan(settleIndex);
    expect(settleIndex).toBeLessThan(playIndex);
    expect(callNames.lastIndexOf('stop')).toBeGreaterThan(playIndex);
  });

  it('reports progress and yields between long render checkpoints', async () => {
    const onProgress = vi.fn();
    const yieldBetweenBlocks = vi.fn(async () => {});

    await renderProjectWithEngine(makeDoc(), {
      ...renderOptions(new FakeEngine()),
      range: { startPpq: 0, endPpq: 8 },
      onProgress,
      yieldBetweenBlocks,
    });

    expect(yieldBetweenBlocks).toHaveBeenCalled();
    expect(onProgress).toHaveBeenCalledWith(0, 'engine.prepare');
    expect(onProgress.mock.calls.some(([, stage]) => stage === 'engine.render')).toBe(true);
    expect(onProgress.mock.calls.at(-1)).toEqual([1, 'done']);
  });

  it('rejects loop and explicit render ranges that cannot produce audio', async () => {
    await expect(
      renderProjectWithEngine(makeDoc(), { ...renderOptions(new FakeEngine()), range: 'loop' }),
    ).rejects.toThrow(/loopRegion/);
    await expect(
      renderProjectWithEngine(makeDoc(), {
        ...renderOptions(new FakeEngine()),
        range: { startPpq: 2, endPpq: 2 },
      }),
    ).rejects.toThrow(/must be after/);
  });

  it('skips the master strip scene but keeps gain/pan without the master chain', async () => {
    const doc = makeDoc();
    (doc.mixer as { master: { inserts: unknown[] } }).master.inserts = [
      { processor: 'dynamics.limiter', params: {}, enabled: true },
    ];
    const withChain = new FakeEngine();
    await renderProjectWithEngine(doc, renderOptions(withChain));
    expect(withChain.named('setMasterStripJson')).toHaveLength(1);

    const withoutChain = new FakeEngine();
    await renderProjectWithEngine(doc, {
      ...renderOptions(withoutChain),
      includeMasterChain: false,
    });
    expect(withoutChain.named('setMasterStripJson')).toHaveLength(0);
    const params = new Map(withoutChain.named('setParameter').map(([, id, value]) => [id, value]));
    expect(params.get(0x4d58ff01)).toBeCloseTo(-3, 5);
  });

  it('renders master panner details even without inserts or EQ', async () => {
    const doc = makeDoc();
    if (!doc.mixer) throw new Error('fixture mixer is missing');
    doc.mixer.master.panLaw = 'const6dB';
    doc.mixer.master.panMode = 'dualPan';
    doc.mixer.master.dualPan = { left: -0.5, right: 0.75 };
    const engine = new FakeEngine();

    await renderProjectWithEngine(doc, renderOptions(engine));

    const scenes = engine.named('setMasterStripJson');
    expect(scenes).toHaveLength(1);
    expect(JSON.parse(scenes[0][1] as string).strips[0]).toMatchObject({
      panLaw: 2,
      panMode: 2,
      dualPanLeft: -0.5,
      dualPanRight: 0.75,
    });
  });

  it('renders stems as isolated engine passes without the master stage', async () => {
    const engines: FakeEngine[] = [];
    const result = await renderProjectWithEngine(makeDoc(), {
      deps: null,
      loadAudioAsset: async () => fakeAsset(),
      createEngine: () => {
        const engine = new FakeEngine();
        engines.push(engine);
        return engine;
      },
      stems: true,
    });

    // One mix pass plus one pass per audible track, each on a fresh engine.
    expect(engines).toHaveLength(3);
    expect(engines.every((engine) => engine.destroyed)).toBe(true);
    expect(result.stems).toHaveLength(2);
    expect(result.stems?.[0]).toMatchObject({ trackIndex: 0, name: 'Keys' });
    expect(result.stems?.[1]).toMatchObject({ trackIndex: 1, name: 'Drums' });
    expect(result.stems?.[0].channels[0].length).toBe(result.totalFrames);
    expect(result.stems?.[0].channels[0][0]).toBeCloseTo(0.25, 5);

    // A stem pass isolates its lane via mutes (solo would keep the document's
    // own soloed tracks audible too).
    const stemPass = engines[1];
    expect(stemPass.named('setSoloMute')).toEqual([
      ['setSoloMute', 0, false, false],
      ['setSoloMute', 1, false, true],
    ]);

    // Stems are pre-master: no master gain/pan and no master automation.
    const stemParams = new Map(stemPass.named('setParameter').map(([, id, value]) => [id, value]));
    expect(stemParams.has(0x4d58ff01)).toBe(false);
    expect(stemParams.has(0x4d58ff02)).toBe(false);
    const stemLaneIds = new Set(stemPass.named('setAutomationLane').map(([, id]) => id));
    expect(stemLaneIds.has(0x4d58ff02)).toBe(false);
    expect(stemLaneIds.has(0x4d580001)).toBe(true);

    // The mix pass keeps the document's solo/mute state and master levels.
    const mixPass = engines[0];
    expect(mixPass.named('setSoloMute')).toEqual([
      ['setSoloMute', 0, false, false],
      ['setSoloMute', 1, false, false],
    ]);
    const mixParams = new Map(mixPass.named('setParameter').map(([, id, value]) => [id, value]));
    expect(mixParams.get(0x4d58ff01)).toBeCloseTo(-3, 5);
  });

  it('awaits and releases streamed stems instead of retaining them in the result', async () => {
    const consumed: Array<{ index: number; total: number; name: string }> = [];
    const result = await renderProjectWithEngine(makeDoc(), {
      deps: null,
      loadAudioAsset: async () => fakeAsset(),
      createEngine: () => new FakeEngine(),
      stems: true,
      onStem: async (stem, index, total) => {
        consumed.push({ index, total, name: stem.name });
      },
    });

    expect(consumed).toEqual([
      { index: 0, total: 2, name: 'Keys' },
      { index: 1, total: 2, name: 'Drums' },
    ]);
    expect(result.stems).toBeUndefined();
  });

  it('streams eligible master PCM blocks without retaining a full mixdown', async () => {
    const chunks: Array<{ offset: number; frames: number }> = [];
    const result = await renderProjectWithEngine(makeDoc(), {
      deps: null,
      loadAudioAsset: async () => fakeAsset(),
      createEngine: () => new FakeEngine(),
      onMixdownChunk: async (channels, offsetFrames, totalFrames) => {
        expect(totalFrames).toBeGreaterThan(0);
        chunks.push({ offset: offsetFrames, frames: channels[0].length });
        expect(channels[1]).toHaveLength(channels[0].length);
      },
    });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]).toEqual({ offset: 0, frames: 1024 });
    expect(chunks.at(-1)!.offset + chunks.at(-1)!.frames).toBe(result.totalFrames);
    expect(result.channels[0]).toHaveLength(0);
    expect(result.channels[1]).toHaveLength(0);
  });

  it('streams WAV PCM even when optional full-buffer metering is available', async () => {
    const chunks: number[] = [];
    const result = await renderProjectWithEngine(makeDoc(), {
      deps: {
        mastering: null,
        metering: { integratedLufs: () => -14 },
      },
      loadAudioAsset: async () => fakeAsset(),
      createEngine: () => new FakeEngine(),
      onMixdownChunk: (channels) => {
        chunks.push(channels[0].length);
      },
    });

    expect(chunks.length).toBeGreaterThan(1);
    expect(result.channels[0]).toHaveLength(0);
    expect(result.report).toMatchObject({ peakDb: expect.any(Number) });
    expect(result.report.lufs).toBeUndefined();
  });

  it('permits a long plain streamed master under a budget that rejects full buffers', async () => {
    const doc = makeDoc();
    doc.tracks = doc.tracks.filter((track) => track.kind === 'midi');
    const chunks: number[] = [];
    await expect(
      renderProjectWithEngine(doc, {
        deps: null,
        createEngine: () => new FakeEngine(),
        memoryBudgetBytes: 1,
        onMixdownChunk: (channels) => {
          chunks.push(channels[0].length);
        },
      }),
    ).resolves.toMatchObject({ channels: [expect.any(Float32Array), expect.any(Float32Array)] });
    expect(chunks.length).toBeGreaterThan(0);
  });

  it('rejects an over-budget render before creating full-length engine passes', async () => {
    const createEngine = vi.fn(() => new FakeEngine());
    await expect(
      renderProjectWithEngine(makeDoc(), {
        deps: null,
        loadAudioAsset: async () => fakeAsset(),
        createEngine,
        stems: true,
        memoryBudgetBytes: 1,
      }),
    ).rejects.toThrow(/working memory/);
    expect(createEngine).not.toHaveBeenCalled();
  });

  it('rejects oversized source PCM from sidecars before loading samples', async () => {
    const loadAudioAsset = vi.fn(async () => fakeAsset());
    const createEngine = vi.fn(() => new FakeEngine());

    await expect(
      renderProjectWithEngine(makeDoc(), {
        deps: null,
        createEngine,
        loadAudioAsset,
        loadAudioAssetMeta: async (assetId) => ({
          id: assetId,
          name: assetId,
          sampleRate: 48_000,
          numChannels: 2,
          numFrames: 30_000_000,
        }),
        memoryBudgetBytes: 64 * 1024 * 1024,
      }),
    ).rejects.toThrow(/Audio export needs about/);

    expect(loadAudioAsset).not.toHaveBeenCalled();
    expect(createEngine).not.toHaveBeenCalled();
  });

  it('prunes audio clips outside an explicit range before metadata and PCM reads', async () => {
    const loadAudioAsset = vi.fn(async () => fakeAsset());
    const loadAudioAssetMeta = vi.fn(async () => fakeAsset().meta);

    await renderProjectWithEngine(makeDoc(), {
      deps: null,
      createEngine: () => new FakeEngine(),
      loadAudioAsset,
      loadAudioAssetMeta,
      range: { startPpq: 0, endPpq: 1 },
    });

    expect(loadAudioAssetMeta).not.toHaveBeenCalled();
    expect(loadAudioAsset).not.toHaveBeenCalled();
  });

  it('prunes muted audio before metadata/PCM reads and project-end calculation', async () => {
    const doc = makeDoc();
    doc.tracks[0].clips[0].lengthPpq = 1;
    doc.tracks[1].mute = true;
    doc.tracks[1].clips[0].startPpq = 100;
    const loadAudioAsset = vi.fn(async () => {
      throw new Error('missing muted media');
    });
    const loadAudioAssetMeta = vi.fn(async () => {
      throw new Error('missing muted metadata');
    });

    const result = await renderProjectWithEngine(doc, {
      deps: null,
      createEngine: () => new FakeEngine(),
      loadAudioAsset,
      loadAudioAssetMeta,
      releaseTailSeconds: 0,
    });

    expect(loadAudioAssetMeta).not.toHaveBeenCalled();
    expect(loadAudioAsset).not.toHaveBeenCalled();
    expect(result.totalFrames).toBe(SAMPLES_PER_PPQ);
  });

  it.each(['pre-fader send', 'master sidechain key'])(
    'loads muted audio needed by a %s before the fader gate',
    async (source) => {
      const doc = makeDoc();
      doc.tracks[1].mute = true;
      if (source === 'pre-fader send') {
        doc.tracks[1].mixer!.sends[0].timing = 'preFader';
      } else {
        doc.tracks[1].mixer!.sends = [];
        doc.mixer!.master.inserts.push({
          processor: 'dynamics.compressor',
          params: {},
          enabled: true,
          sidechainSourceIndex: 1,
        } as InsertSlot);
      }
      const loadAudioAsset = vi.fn(async () => fakeAsset());
      const loadAudioAssetMeta = vi.fn(async () => fakeAsset().meta);

      await renderProjectWithEngine(doc, {
        deps: null,
        createEngine: () => new FakeEngine(),
        loadAudioAsset,
        loadAudioAssetMeta,
        range: { startPpq: 2, endPpq: 4 },
      });

      expect(loadAudioAssetMeta).toHaveBeenCalled();
      expect(loadAudioAsset).toHaveBeenCalled();
    },
  );

  it('renders requested mixer buses as return stems', async () => {
    const engines: FakeEngine[] = [];
    const result = await renderProjectWithEngine(makeDoc(), {
      deps: null,
      loadAudioAsset: async () => fakeAsset(),
      createEngine: () => {
        const engine = new FakeEngine();
        engines.push(engine);
        return engine;
      },
      stems: true,
      busStems: true,
    });

    expect(engines).toHaveLength(4);
    expect(result.stems?.map((stem) => stem.name)).toEqual(['Keys', 'Drums', 'A Return']);
    expect(result.stems?.[2]).toMatchObject({
      source: 'bus',
      trackIndex: -1,
      busId: 'bus-a',
      busIndex: 0,
      name: 'A Return',
    });

    const busStemPass = engines[3];
    expect(busStemPass.named('setTrackBuses')[0][1]).toEqual([
      { busId: 1, gainDb: -6 },
      { busId: 2, gainDb: -120 },
    ]);
    expect(busStemPass.named('setTrackLanes')[0][1]).toEqual([
      { trackId: 1, outputBusId: 2 },
      {
        trackId: 2,
        sends: [{ busId: 1, levelDb: -9, enabled: true }],
        outputBusId: 2,
      },
    ]);
    expect(busStemPass.named('setSoloMute')).toEqual([
      ['setSoloMute', 0, false, false],
      ['setSoloMute', 1, false, false],
    ]);
    const params = new Map(busStemPass.named('setParameter').map(([, id, value]) => [id, value]));
    expect(params.has(0x4d58ff01)).toBe(false);
    expect(params.has(0x4d58ff02)).toBe(false);
  });

  it('assigns group members and sends to exactly one stem domain', async () => {
    const doc = makeGroupDoc();
    const keys = doc.tracks[0] as {
      mixer?: {
        gainDb: number;
        pan: number;
        inserts: unknown[];
        sends: Array<{ busId: string; levelDb: number; enabled: boolean }>;
      };
    };
    keys.mixer = {
      gainDb: 0,
      pan: 0,
      inserts: [],
      sends: [{ busId: 'bus-a', levelDb: -12, enabled: true }],
    };
    const engines: FakeEngine[] = [];

    const result = await renderProjectWithEngine(doc, {
      deps: null,
      loadAudioAsset: async () => fakeAsset(),
      createEngine: () => {
        const engine = new FakeEngine();
        engines.push(engine);
        return engine;
      },
      stems: true,
      busStems: true,
    });

    // Keys owns its direct stem, Drums is owned by Drum Bus, and every send
    // contribution belongs only to A Return.
    expect(result.stems?.map((stem) => stem.trackIndex)).toEqual([0, 2, -1]);
    const directStemPass = engines[1];
    expect(directStemPass.named('setTrackLanes')[0][1]).toEqual([
      { trackId: 1 },
      { trackId: 2 },
      { trackId: 3 },
    ]);
    const groupStemPass = engines[2];
    expect(groupStemPass.named('setTrackLanes')[0][1]).toEqual([
      { trackId: 1 },
      { trackId: 2, outputBusId: 2 },
      { trackId: 3 },
    ]);
    const returnStemPass = engines[3];
    expect(returnStemPass.named('setTrackLanes')[0][1]).toEqual([
      { trackId: 1, sends: [{ busId: 1, levelDb: -12, enabled: true }], outputBusId: 3 },
      { trackId: 2, sends: [{ busId: 1, levelDb: -9, enabled: true }], outputBusId: 3 },
      { trackId: 3, outputBusId: 3 },
    ]);
  });

  it('includes solo-safe tracks in stem exports while another track is soloed', async () => {
    const doc = makeDoc();
    doc.tracks[0].solo = true;
    doc.tracks[1].soloSafe = true;

    const engines: FakeEngine[] = [];
    const result = await renderProjectWithEngine(doc, {
      deps: null,
      loadAudioAsset: async () => fakeAsset(),
      createEngine: () => {
        const engine = new FakeEngine();
        engines.push(engine);
        return engine;
      },
      stems: true,
    });

    expect(result.stems?.map((stem) => stem.trackIndex)).toEqual([0, 1]);
    expect(result.stems?.map((stem) => stem.name)).toEqual(['Keys', 'Drums']);
    // Mix + two audible stem passes: the solo-safe lane is treated as audible.
    expect(engines).toHaveLength(3);
  });

  it('applies the mastering preset and enabled processors to the final stereo mix only', async () => {
    const doc = makeDoc();
    doc.mixer = {
      ...doc.mixer,
      masteringChain: {
        preset: 'streaming',
        presetOverrides: { 'loudness.targetLufs': -14 },
        processors: [
          { processor: 'eq.tilt', params: { tiltDb: 1 }, enabled: true },
          { processor: 'saturation.tape', params: { drive: 0.4 }, enabled: false },
          { processor: 'maximizer.truePeakLimiter', params: { ceilingDb: -1 }, enabled: true },
        ],
      },
    };
    const applyPreset = vi.fn((_preset, left: Float32Array, right: Float32Array) => ({
      left: Float32Array.from(left, (value) => value * 2),
      right: Float32Array.from(right, (value) => value * 2),
    }));
    const processStereo = vi.fn((name: string, left: Float32Array, right: Float32Array) => {
      const gain = name === 'eq.tilt' ? 0.5 : 0.25;
      return {
        left: Float32Array.from(left, (value) => value * gain),
        right: Float32Array.from(right, (value) => value * gain),
      };
    });

    const result = await renderProjectWithEngine(doc, {
      ...renderOptions(new FakeEngine()),
      deps: { mastering: { applyPreset, processStereo }, metering: null },
    });

    expect(applyPreset).toHaveBeenCalledWith(
      'streaming',
      expect.any(Float32Array),
      expect.any(Float32Array),
      48000,
      { 'loudness.targetLufs': -14 },
    );
    expect(processStereo.mock.calls.map(([name]) => name)).toEqual([
      'eq.tilt',
      'maximizer.truePeakLimiter',
    ]);
    expect(result.channels[0][0]).toBeCloseTo(0.25 * 2 * 0.5 * 0.25, 5);
    expect(result.channels[1][0]).toBeCloseTo(0.25 * 2 * 0.5 * 0.25, 5);
    expect(result.report.peakDb).toBeCloseTo(20 * Math.log10(0.0625), 5);
  });

  it('reports a mastering preset that stopped short of its loudness target', async () => {
    const doc = makeDoc();
    doc.mixer = { ...doc.mixer, masteringChain: { preset: 'kpop', processors: [] } };
    const applyPreset = vi.fn((_preset, left: Float32Array, right: Float32Array) => ({
      left,
      right,
      loudnessTargetLimited: true,
      outputLufs: -10.26,
    }));

    const result = await renderProjectWithEngine(doc, {
      ...renderOptions(new FakeEngine()),
      deps: { mastering: { applyPreset, processStereo: vi.fn() }, metering: null },
    });

    expect(result.report.limitations).toEqual([
      { kind: 'mastering-loudness-target-limited', outputLufs: -10.26 },
    ]);
  });

  it('applies every mastering processor offline in declared rack order', async () => {
    const doc = makeDoc();
    doc.mixer = {
      ...doc.mixer,
      master: { ...doc.mixer.master, gainDb: -6 },
      masteringChain: {
        processors: [
          { processor: 'maximizer.truePeakLimiter', params: { ceilingDb: -1 }, enabled: true },
          { processor: 'repair.declick', params: {}, enabled: true },
        ],
      },
    };
    const engine = new FakeEngine();
    const processStereo = vi.fn((_: string, left: Float32Array, right: Float32Array) => ({
      left,
      right,
    }));

    await renderProjectWithEngine(doc, {
      ...renderOptions(engine),
      deps: { mastering: { processStereo }, metering: null },
    });

    expect(engine.named('setMasterStripJson')).toEqual([]);
    expect(processStereo.mock.calls.map(([name]) => name)).toEqual([
      'maximizer.truePeakLimiter',
      'repair.declick',
    ]);
    expect(engine.named('setParameter')).toContainEqual(['setParameter', 0x4d58ff01, -6]);
  });

  it('drives a time-varying mastering parameter through its own engine pass', async () => {
    const doc = makeDoc();
    doc.mixer = {
      ...doc.mixer,
      masteringChain: {
        processors: [
          { processor: 'saturation.tape', params: { driveDb: 3 }, enabled: true },
          { processor: 'eq.tilt', params: { tiltDb: 0 }, enabled: true },
          { processor: 'repair.declick', params: {}, enabled: true },
        ],
      },
    };
    doc.masterAutomation = [
      {
        param: masteringAutomationParam(1, 'tiltDb'),
        enabled: true,
        points: [
          { ppq: 0, value: 0 },
          { ppq: 8, value: 6 },
        ],
      },
    ];
    const processStereo = vi.fn((_name: string, left: Float32Array, right: Float32Array) => ({
      left,
      right,
    }));
    const engines: FakeEngine[] = [];

    const result = await renderProjectWithEngine(doc, {
      deps: { mastering: { processStereo }, metering: null },
      loadAudioAsset: async () => fakeAsset(),
      createEngine: () => {
        const engine = new FakeEngine();
        engines.push(engine);
        return engine;
      },
      masteringCapability: (processor) =>
        processor === 'eq.tilt'
          ? {
              realtimeInsertable: true,
              latencySamples: 0,
              automatableParams: new Set(['tiltDb']),
            }
          : undefined,
    });

    // The automated stage left the whole-buffer path; the stages around it did
    // not, and they still run in declared order.
    expect(processStereo.mock.calls.map((call) => call[0])).toEqual([
      'saturation.tape',
      'repair.declick',
    ]);
    expect(result.report.limitations).toBeUndefined();
    // The pass is a second engine whose strip is the automated processor alone.
    expect(engines).toHaveLength(2);
    const [[, , json]] = engines[1].named('setTrackStripJson') as Array<[string, number, string]>;
    expect(JSON.parse(json).strips[0].inserts).toEqual([
      { slot: 'pre', processor: 'eq.tilt', params: { tiltDb: 0 } },
    ]);
    expect(engines[1].named('setAutomationLane')).toEqual([
      [
        'setAutomationLane',
        0xe0010000,
        [
          { ppq: 0, value: 0, curveToNext: 0 },
          { ppq: 8, value: 6, curveToNext: 0 },
        ],
      ],
    ]);
    expect(engines[1].destroyed).toBe(true);
  });

  it('applies static mastering processor automation to offline mastering params', async () => {
    const doc = makeDoc();
    doc.mixer = {
      ...doc.mixer,
      masteringChain: {
        processors: [
          { processor: 'maximizer.truePeakLimiter', params: { ceilingDb: -1 }, enabled: true },
        ],
      },
    };
    doc.masterAutomation = [
      {
        param: masteringAutomationParam(0, 'ceilingDb'),
        enabled: true,
        points: [
          { ppq: 0, value: -6 },
          { ppq: 8, value: -3 },
        ],
      },
    ];
    const processStereo = vi.fn((_name: string, left: Float32Array, right: Float32Array) => ({
      left,
      right,
    }));

    const engine = new FakeEngine();
    const result = await renderProjectWithEngine(doc, {
      ...renderOptions(engine),
      deps: { mastering: { processStereo }, metering: null },
    });

    expect(processStereo).toHaveBeenCalledWith(
      'maximizer.truePeakLimiter',
      expect.any(Float32Array),
      expect.any(Float32Array),
      48000,
      { ceilingDb: -6 },
    );
    expect(result.report.limitations).toEqual([
      {
        kind: 'mastering-automation-at-render-start',
        params: ['maximizer.truePeakLimiter.ceilingDb'],
      },
    ]);
    expect(engine.named('resolveMasterInsertAutomationId')).toEqual([]);
  });

  it('keeps stem renders pre-master while mastering changes the final mix', async () => {
    const doc = makeDoc();
    doc.mixer = {
      ...doc.mixer,
      masteringChain: {
        processors: [{ processor: 'maximizer.truePeakLimiter', params: {}, enabled: true }],
      },
    };
    const processStereo = vi.fn((_name: string, left: Float32Array, right: Float32Array) => ({
      left: Float32Array.from(left, (value) => value * 0.1),
      right: Float32Array.from(right, (value) => value * 0.1),
    }));

    const result = await renderProjectWithEngine(doc, {
      ...renderOptions(new FakeEngine()),
      deps: { mastering: { processStereo }, metering: null },
      stems: true,
    });

    expect(processStereo).toHaveBeenCalledTimes(1);
    expect(result.channels[0][0]).toBeCloseTo(0.025, 5);
    expect(result.channels[1][0]).toBeCloseTo(0.025, 5);
    expect(result.stems?.[0].channels[0][0]).toBeCloseTo(0.25, 5);
    expect(result.stems?.[1].channels[0][0]).toBeCloseTo(0.25, 5);
    expect(result.report.peakDb).toBeCloseTo(20 * Math.log10(0.025), 5);
  });

  it('can include the final stereo master as a stem without another engine pass', async () => {
    const doc = makeDoc();
    doc.mixer = {
      ...doc.mixer,
      masteringChain: {
        processors: [{ processor: 'maximizer.truePeakLimiter', params: {}, enabled: true }],
      },
    };
    const processStereo = vi.fn((_name: string, left: Float32Array, right: Float32Array) => ({
      left: Float32Array.from(left, (value) => value * 0.1),
      right: Float32Array.from(right, (value) => value * 0.1),
    }));
    const engines: FakeEngine[] = [];

    const result = await renderProjectWithEngine(doc, {
      deps: { mastering: { processStereo }, metering: null },
      loadAudioAsset: async () => fakeAsset(),
      createEngine: () => {
        const engine = new FakeEngine();
        engines.push(engine);
        return engine;
      },
      stems: true,
      masterStem: true,
    });

    expect(engines).toHaveLength(3);
    expect(result.stems?.map((stem) => stem.name)).toEqual(['Keys', 'Drums', 'Master']);
    const masterStem = result.stems?.[2];
    expect(masterStem).toMatchObject({
      source: 'master',
      trackIndex: Number.MIN_SAFE_INTEGER,
      name: 'Master',
    });
    expect(masterStem?.channels[0][0]).toBeCloseTo(result.channels[0][0], 5);
    expect(masterStem?.channels[1][0]).toBeCloseTo(result.channels[1][0], 5);
    expect(masterStem?.channels[0]).not.toBe(result.channels[0]);
  });

  it('reports peak from the stereo mix after independent mastering output', async () => {
    class StereoFillEngine extends FakeEngine {
      process(channels: Float32Array[]): Float32Array[] {
        channels[0].fill(0.2);
        (channels[1] ?? channels[0]).fill(0.4);
        return channels;
      }
    }
    const doc = makeDoc();
    doc.mixer = {
      ...doc.mixer,
      masteringChain: {
        processors: [{ processor: 'eq.tilt', params: {}, enabled: true }],
      },
    };
    const processStereo = vi.fn((_name: string, left: Float32Array, right: Float32Array) => ({
      left: Float32Array.from(left, (value) => value * 0.5),
      right: Float32Array.from(right, (value) => value * 2),
    }));

    const result = await renderProjectWithEngine(doc, {
      ...renderOptions(new StereoFillEngine()),
      deps: { mastering: { processStereo }, metering: null },
    });

    expect(result.channels[0][0]).toBeCloseTo(0.1, 5);
    expect(result.channels[1][0]).toBeCloseTo(0.8, 5);
    expect(result.report.peakDb).toBeCloseTo(20 * Math.log10(0.8), 5);
  });

  it('cancels at preparation checkpoints before allocating an engine pass', async () => {
    const engine = new FakeEngine();
    let blocks = 0;
    const promise = renderProjectWithEngine(makeDoc(), {
      ...renderOptions(engine),
      shouldCancel: () => ++blocks > 1,
    });
    await expect(promise).rejects.toBeInstanceOf(MixdownCancelledError);
    expect(engine.destroyed).toBe(false);
  });

  it('schedules a warp-enabled clip (no takes) as one time-stretched engine clip', async () => {
    const doc = makeDoc();
    // sourceBpm 240: the 2 PPQ window covers 0.5 s of source (24000 frames),
    // stretched onto 1 s (48000 frames) at the 120 BPM document tempo.
    doc.tracks[1].clips[0].warp = { enabled: true, sourceBpm: 240 };

    // Mono index ramp so warped sample positions are observable.
    const rampFrames = 48000;
    const ramp = new Float32Array(rampFrames);
    for (let i = 0; i < rampFrames; i++) ramp[i] = i;
    const engine = new FakeEngine();
    await renderProjectWithEngine(doc, {
      deps: null,
      createEngine: () => engine,
      loadAudioAsset: async () => ({
        meta: {
          id: 'asset-1',
          name: 'loop.wav',
          sampleRate: 48000,
          numChannels: 1,
          numFrames: rampFrames,
        },
        channels: [ramp],
      }),
    });

    const clips = engine.named('setClips')[0][1] as Array<{
      trackId: number;
      channels: Float32Array[];
      startPpq: number;
      lengthSamples: number;
      gain?: number;
      warpMode?: string;
      warpAnchors?: Array<{ warpSample: number; sourceSample: number }>;
    }>;
    // One engine clip whose length is exactly lengthPpq at the render tempo.
    expect(clips).toHaveLength(1);
    expect(clips[0].trackId).toBe(2);
    expect(clips[0].startPpq).toBe(2);
    expect(clips[0].lengthSamples).toBe(48000);
    expect(clips[0].gain).toBeCloseTo(0.8, 5);
    // The engine stretches the 24000-frame source slice over 48000 frames.
    expect(clips[0].warpMode).toBe('time-stretch');
    expect(clips[0].warpAnchors).toEqual([
      { warpSample: 0, sourceSample: 0 },
      { warpSample: 48000, sourceSample: 24000 },
    ]);
    expect(clips[0].channels[0].length).toBe(24000);
    expect(clips[0].channels[0][4000]).toBe(4000);
  });

  it('stretches warped audio clips to the document tempo-map length', async () => {
    const doc = makeDoc();
    doc.tempoSegments = [
      { startPpq: 0, bpm: 120 },
      { startPpq: 3, bpm: 60 },
    ];
    doc.tracks[1].clips[0].warp = { enabled: true, sourceBpm: 60 };

    const rampFrames = 96000;
    const ramp = new Float32Array(rampFrames);
    for (let i = 0; i < rampFrames; i++) ramp[i] = i;
    const engine = new FakeEngine();
    await renderProjectWithEngine(doc, {
      deps: null,
      createEngine: () => engine,
      loadAudioAsset: async () => ({
        meta: {
          id: 'asset-1',
          name: 'warped-variable-tempo.wav',
          sampleRate: 48000,
          numChannels: 1,
          numFrames: rampFrames,
        },
        channels: [ramp],
      }),
    });

    const clips = engine.named('setClips')[0][1] as Array<{
      channels: Float32Array[];
      lengthSamples: number;
      warpAnchors?: Array<{ warpSample: number; sourceSample: number }>;
    }>;
    expect(clips).toHaveLength(1);
    // Clip 2..4 PPQ spans 0.5 s at 120 BPM plus 1 s at 60 BPM.
    expect(clips[0].lengthSamples).toBe(72000);
    expect(clips[0].channels[0].length).toBe(96000);
    expect(clips[0].warpAnchors).toEqual([
      { warpSample: 0, sourceSample: 0 },
      { warpSample: 72000, sourceSample: 96000 },
    ]);
  });

  it('slices unwarped audio clips with the document tempo map', async () => {
    const doc = makeDoc();
    doc.tempoSegments = [
      { startPpq: 0, bpm: 120 },
      { startPpq: 1, bpm: 60 },
    ];
    const engine = new FakeEngine();
    await renderProjectWithEngine(doc, {
      deps: null,
      createEngine: () => engine,
      loadAudioAsset: async () => ({
        meta: {
          id: 'asset-1',
          name: 'variable-tempo.wav',
          sampleRate: 48000,
          numChannels: 1,
          numFrames: 96000,
        },
        channels: [new Float32Array(96000).fill(0.5)],
      }),
    });

    const clips = engine.named('setClips')[0][1] as Array<{
      channels: Float32Array[];
      lengthSamples: number;
    }>;
    expect(clips).toHaveLength(1);
    // The source window is anchored at clip timeline 2..4 PPQ, entirely at 60 BPM.
    expect(clips[0].lengthSamples).toBe(96000);
    expect(clips[0].channels[0].length).toBe(96000);
  });

  it('renders warped audio clips audibly from the stretched sample positions', async () => {
    const doc = makeDoc();
    doc.tracks[0].mute = true;
    doc.tracks[1].clips[0].warp = { enabled: true, sourceBpm: 240 };
    const rampFrames = 48000;
    const ramp = new Float32Array(rampFrames);
    for (let i = 0; i < rampFrames; i++) ramp[i] = i / rampFrames;

    const result = await renderProjectWithEngine(doc, {
      deps: null,
      createEngine: () => new AudibilityEngine(),
      loadAudioAsset: async () => ({
        meta: {
          id: 'asset-1',
          name: 'warped-ramp.wav',
          sampleRate: 48000,
          numChannels: 1,
          numFrames: rampFrames,
        },
        channels: [ramp],
      }),
    });
    const audioStart = 2 * SAMPLES_PER_PPQ;

    expect(result.channels[0][audioStart]).toBeCloseTo(0, 5);
    expect(result.channels[0][audioStart + 4000]).toBeCloseTo(
      defaultAudioLevel(2000 / rampFrames),
      5,
    );
  });

  it('does not send empty audio clip windows to the offline engine', async () => {
    const doc = makeDoc();
    doc.tracks[1].clips[0].sourceOffsetPpq = 100;
    doc.tracks[1].clips[0].lengthPpq = 1;
    const engine = new FakeEngine();

    await renderProjectWithEngine(doc, {
      deps: null,
      createEngine: () => engine,
      loadAudioAsset: async () => fakeAsset(),
    });

    expect(engine.named('setClips')).toEqual([]);
    // MIDI still schedules, so this only proves the empty audio window was
    // dropped rather than the whole render being skipped.
    expect(engine.named('setMidiClips')).toHaveLength(1);
  });

  it('keeps missing audio assets silent without cancelling MIDI playback', async () => {
    const doc = makeDoc();
    const engine = new AudibilityEngine();

    const result = await renderProjectWithEngine(doc, {
      deps: null,
      createEngine: () => engine,
      loadAudioAsset: async () => {
        throw new Error('missing asset');
      },
    });

    expect(engine.named('setClips')).toEqual([]);
    expect(result.channels[0][0]).toBeCloseTo(defaultMidiLevel(96), 5);
    expect(result.channels[0][2 * SAMPLES_PER_PPQ]).toBeCloseTo(0, 5);
    expect(result.report.mediaIssues).toEqual([
      {
        kind: 'audio-asset',
        id: 'asset-1',
        reason: 'missing-or-unreadable',
        message: 'missing asset',
      },
    ]);
  });

  it('reports missing SoundFonts as structured export media issues', async () => {
    const doc = makeDoc();
    doc.tracks[0].instrument = { kind: 'sf2', fontId: 'missing-piano' };

    const result = await renderProjectWithEngine(doc, {
      deps: null,
      createEngine: () => new AudibilityEngine(),
      loadFont: async () => {
        throw new Error('font store is unavailable');
      },
      loadAudioAsset: async () => fakeAsset(),
    });

    expect(result.report.mediaIssues).toEqual([
      {
        kind: 'soundfont',
        id: 'missing-piano',
        reason: 'missing-or-unreadable',
        message: 'font store is unavailable',
      },
    ]);
  });

  it('keeps the unwarped comp path for a clip with takes and warp', async () => {
    const doc = makeDoc();
    const drumClip = doc.tracks[1].clips[0];
    drumClip.warp = { enabled: true, sourceBpm: 240 };
    drumClip.takes = [
      { assetId: 'asset-1', name: 'Take 1' },
      { assetId: 'asset-2', name: 'Take 2' },
    ];
    drumClip.compSegments = [
      { startPpq: 0, takeIndex: 0 },
      { startPpq: 1, takeIndex: 1, crossfadePpq: 0 },
    ];

    const rampFrames = 48000;
    const ramp = new Float32Array(rampFrames);
    for (let i = 0; i < rampFrames; i++) ramp[i] = i;
    const engine = new FakeEngine();
    await renderProjectWithEngine(doc, {
      deps: null,
      createEngine: () => engine,
      loadAudioAsset: async (assetId: string) =>
        assetId === 'asset-2'
          ? {
              meta: {
                id: 'asset-2',
                name: 'take2.wav',
                sampleRate: 48000,
                numChannels: 1,
                numFrames: rampFrames,
              },
              channels: [ramp],
            }
          : fakeAsset(),
    });

    const clips = engine.named('setClips')[0][1] as Array<{
      channels: Float32Array[];
      startPpq: number;
      lengthSamples: number;
    }>;
    // The comp expansion wins: two fixed-rate segments, never stretched.
    expect(clips).toHaveLength(2);
    expect(clips.map((clip) => clip.startPpq)).toEqual([2, 3]);
    expect(clips.map((clip) => clip.lengthSamples)).toEqual([24000, 24000]);
    // Second segment reads take 2 verbatim from source offset 1 PPQ.
    expect(clips[1].channels[0][0]).toBe(24000);
    expect(clips.every((clip) => !('warpMode' in clip))).toBe(true);
  });

  it('expands looping audio clips into repeated offline engine clips', async () => {
    const doc = makeDoc();
    const drumClip = doc.tracks[1].clips[0];
    drumClip.startPpq = 2;
    drumClip.lengthPpq = 3;
    drumClip.sourceOffsetPpq = 1;
    drumClip.loopEnabled = true;
    drumClip.loopLengthPpq = 1;

    const rampFrames = 6 * SAMPLES_PER_PPQ;
    const ramp = new Float32Array(rampFrames);
    for (let i = 0; i < rampFrames; i++) ramp[i] = i;
    const engine = new FakeEngine();
    await renderProjectWithEngine(doc, {
      deps: null,
      createEngine: () => engine,
      loadAudioAsset: async () => ({
        meta: {
          id: 'asset-1',
          name: 'loop.wav',
          sampleRate: 48000,
          numChannels: 1,
          numFrames: rampFrames,
        },
        channels: [ramp],
      }),
    });

    const clips = engine.named('setClips')[0][1] as Array<{
      channels: Float32Array[];
      startPpq: number;
      lengthSamples: number;
    }>;
    expect(clips).toHaveLength(3);
    expect(clips.map((clip) => clip.startPpq)).toEqual([2, 3, 4]);
    expect(clips.map((clip) => clip.lengthSamples)).toEqual([
      SAMPLES_PER_PPQ,
      SAMPLES_PER_PPQ,
      SAMPLES_PER_PPQ,
    ]);
    for (const clip of clips) {
      expect(clip.channels[0][0]).toBe(SAMPLES_PER_PPQ);
      expect(clip.channels[0][SAMPLES_PER_PPQ - 1]).toBe(2 * SAMPLES_PER_PPQ - 1);
    }
  });

  it('exports looped warp occurrences with tempo-mapped and partial lengths', async () => {
    const doc = makeDoc();
    doc.tempoSegments = [
      { startPpq: 0, bpm: 120 },
      { startPpq: 2, bpm: 60 },
    ];
    const clip = doc.tracks[1].clips[0];
    clip.startPpq = 0;
    clip.lengthPpq = 5;
    clip.sourceOffsetPpq = 0;
    clip.loopEnabled = true;
    clip.loopLengthPpq = 2;
    clip.warp = { enabled: true, sourceBpm: 60 };

    const source = new Float32Array(96_000);
    for (let i = 0; i < source.length; i++) source[i] = i;
    const engine = new FakeEngine();
    await renderProjectWithEngine(doc, {
      deps: null,
      createEngine: () => engine,
      loadAudioAsset: async () => ({
        meta: {
          id: 'asset-1',
          name: 'loop-warp.wav',
          sampleRate: 48_000,
          numChannels: 1,
          numFrames: source.length,
        },
        channels: [source],
      }),
    });

    const clips = engine.named('setClips')[0][1] as Array<{
      channels: Float32Array[];
      startPpq: number;
      lengthSamples: number;
      warpAnchors?: Array<{ warpSample: number; sourceSample: number }>;
    }>;
    expect(clips).toHaveLength(3);
    expect(clips.map((entry) => entry.startPpq)).toEqual([0, 2, 4]);
    expect(clips.map((entry) => entry.lengthSamples)).toEqual([48_000, 96_000, 48_000]);
    // Each occurrence stretches its own source span onto its tempo-mapped length.
    expect(clips.map((entry) => entry.warpAnchors?.[1])).toEqual([
      { warpSample: 48_000, sourceSample: 96_000 },
      { warpSample: 96_000, sourceSample: 96_000 },
      { warpSample: 48_000, sourceSample: 48_000 },
    ]);
  });

  it('expands a comped audio clip into one engine clip per segment', async () => {
    const doc = makeDoc();
    const drumClip = doc.tracks[1].clips[0];
    drumClip.takes = [
      { assetId: 'asset-1', name: 'Take 1' },
      { assetId: 'asset-2', name: 'Take 2' },
    ];
    drumClip.compSegments = [
      { startPpq: 0, takeIndex: 0 },
      { startPpq: 1, takeIndex: 1, crossfadePpq: 0 },
    ];

    // asset-1: constant stereo 0.5 (fakeAsset); asset-2: a mono index ramp so
    // the per-segment source offset is observable in the scheduled samples.
    const rampFrames = 48000;
    const ramp = new Float32Array(rampFrames);
    for (let i = 0; i < rampFrames; i++) ramp[i] = i;
    const engine = new FakeEngine();
    await renderProjectWithEngine(doc, {
      deps: null,
      createEngine: () => engine,
      loadAudioAsset: async (assetId: string) =>
        assetId === 'asset-2'
          ? {
              meta: {
                id: 'asset-2',
                name: 'take2.wav',
                sampleRate: 48000,
                numChannels: 1,
                numFrames: rampFrames,
              },
              channels: [ramp],
            }
          : fakeAsset(),
    });

    const clips = engine.named('setClips')[0][1] as Array<{
      trackId: number;
      channels: Float32Array[];
      startPpq: number;
      lengthSamples: number;
      gain?: number;
    }>;
    expect(clips).toHaveLength(2);
    expect(clips.map((clip) => clip.trackId)).toEqual([2, 2]);
    // Clip at PPQ 2, segments at clip-relative 0 and 1.
    expect(clips.map((clip) => clip.startPpq)).toEqual([2, 3]);
    // Each segment is 1 PPQ = 0.5 s = 24000 frames at 120 BPM / 48 kHz.
    expect(clips.map((clip) => clip.lengthSamples)).toEqual([24000, 24000]);
    expect(clips[0].gain).toBeCloseTo(0.8, 5);
    expect(clips[1].gain).toBeCloseTo(0.8, 5);

    // First segment: take 1 (stereo, constant 0.5) from source offset 0.
    expect(clips[0].channels).toHaveLength(2);
    expect(clips[0].channels[0][0]).toBeCloseTo(0.5, 5);
    expect(clips[0].channels[0][23999]).toBeCloseTo(0.5, 5);
    // Second segment: take 2 (mono ramp) from source offset 1 PPQ = 24000 frames.
    expect(clips[1].channels).toHaveLength(1);
    expect(clips[1].channels[0][0]).toBe(24000);
    expect(clips[1].channels[0][23999]).toBe(47999);
  });

  it('renders comped audio segments audibly at their segment positions', async () => {
    const doc = makeDoc();
    doc.tracks[0].mute = true;
    const drumClip = doc.tracks[1].clips[0];
    drumClip.takes = [
      { assetId: 'asset-1', name: 'Take 1' },
      { assetId: 'asset-2', name: 'Take 2' },
    ];
    drumClip.compSegments = [
      { startPpq: 0, takeIndex: 0 },
      { startPpq: 1, takeIndex: 1, crossfadePpq: 0 },
    ];
    const rampFrames = 48000;
    const ramp = new Float32Array(rampFrames);
    for (let i = 0; i < rampFrames; i++) ramp[i] = i / rampFrames;

    const result = await renderProjectWithEngine(doc, {
      deps: null,
      createEngine: () => new AudibilityEngine(),
      loadAudioAsset: async (assetId: string) =>
        assetId === 'asset-2'
          ? {
              meta: {
                id: 'asset-2',
                name: 'take2-ramp.wav',
                sampleRate: 48000,
                numChannels: 1,
                numFrames: rampFrames,
              },
              channels: [ramp],
            }
          : fakeAsset(),
    });

    expect(result.channels[0][2 * SAMPLES_PER_PPQ]).toBeCloseTo(defaultAudioLevel(0.5), 5);
    expect(result.channels[0][3 * SAMPLES_PER_PPQ]).toBeCloseTo(defaultAudioLevel(0.5), 5);
    expect(result.channels[0][3 * SAMPLES_PER_PPQ + 1000]).toBeCloseTo(
      defaultAudioLevel(25000 / rampFrames),
      5,
    );
  });
});

describe('renderProjectWithEngine offline mixer parity', () => {
  it('maps document group membership into the live PDC identity plan', async () => {
    const doc = makeGroupDoc();
    (doc.tracks[0] as { mixer: Record<string, unknown> }).mixer = {
      gainDb: 0,
      pan: 0,
      inserts: [{ processor: 'linear.eq', params: {}, enabled: true }],
      sends: [],
    };
    const engine = new FakeEngine();

    await renderProjectWithEngine(doc, {
      ...renderOptions(engine),
      insertLatency: (slot) => {
        if (slot.processor === 'linear.eq') return 256;
        if (slot.processor === 'dynamics.compressor') return 128;
        return 0;
      },
    });

    // Track 2 has no local insert latency but routes through the 128-sample
    // group bus; track 1's 256-sample insert sets the project maximum.
    expect(engine.named('setTrackStripChannelDelaySamples')).toContainEqual([
      'setTrackStripChannelDelaySamples',
      2,
      128,
    ]);
  });

  it('matches live PDC delays for every audible lane through a latent group bus', async () => {
    const doc = makeGroupDoc();
    (doc.tracks[0] as { mixer: Record<string, unknown> }).mixer = {
      gainDb: 0,
      pan: 0,
      inserts: [{ processor: 'linear.eq', params: {}, enabled: true }],
      sends: [],
    };
    const insertLatency = (slot: { processor: string }): number => {
      if (slot.processor === 'linear.eq') return 256;
      if (slot.processor === 'dynamics.compressor') return 128;
      return 0;
    };
    const liveEngine = {
      setTrackLanes: vi.fn(),
      setStripGain: vi.fn(),
      setStripPan: vi.fn(),
      setSoloMute: vi.fn(),
      setTrackStripChannelDelaySamples: vi.fn(),
      setTrackStripPanLaw: vi.fn(),
      setTrackStripPanMode: vi.fn(),
      setTrackStripDualPan: vi.fn(),
    };
    const liveTracks: EditorTrack[] = doc.tracks.map((track, index) => ({
      id: index + 1,
      name: track.name,
      color: track.color,
      kind: track.kind,
      mute: track.mute,
      solo: track.solo,
      soloSafe: track.soloSafe,
      vcaId: track.vcaId,
      volume: track.volume,
      pan: track.pan,
      order: index,
      mixer: track.mixer,
      ...(track.groupIndex === undefined ? {} : { groupId: track.groupIndex + 1 }),
    }));
    createMixerSync({ engine: liveEngine } as unknown as EngineHandle, { insertLatency }).sync(
      liveTracks,
      doc.mixer!.master,
    );

    const offline = new FakeEngine();
    await renderProjectWithEngine(doc, { ...renderOptions(offline), insertLatency });
    const liveDelays = new Map<number, number>(liveTracks.map((track) => [track.id, 0]));
    for (const [trackId, delay] of liveEngine.setTrackStripChannelDelaySamples.mock.calls) {
      liveDelays.set(trackId as number, delay as number);
    }
    const offlineDelays = new Map<number, number>(
      liveTracks.filter((track) => track.kind !== 'group').map((track) => [track.id, 0]),
    );
    for (const [, trackId, delay] of offline.named('setTrackStripChannelDelaySamples')) {
      offlineDelays.set(trackId as number, delay as number);
    }

    // Group tracks are routing buses, not audible lanes. Every actual content
    // lane must receive exactly the same delay in live sync and offline render.
    expect([...offlineDelays.entries()].sort()).toEqual(
      [...liveDelays.entries()].filter(([trackId]) => trackId !== 3).sort(),
    );
    expect(offlineDelays.get(2)).toBe(128);
  });

  it('renders the program output in PFL mode, leaving the solo cue out', async () => {
    const doc = makeDoc();
    doc.mixer!.soloMode = 'pfl';
    doc.mixer!.vcaGroups = [{ id: 'vca-1', name: 'VCA 1', gainDb: 0, solo: true }];
    doc.tracks[0].solo = true;
    doc.tracks[1].vcaId = 'vca-1';
    doc.tracks[0].automation = [
      { param: 'faderDb', enabled: true, points: [{ ppq: 0, value: 6 }] },
      { param: 'pan', enabled: true, points: [{ ppq: 0, value: 1 }] },
    ];
    const engine = new FakeEngine();

    await renderProjectWithEngine(doc, renderOptions(engine));

    expect(engine.named('setSoloMute').every(([, , solo]) => solo === false)).toBe(true);
    expect(engine.named('setParameter')).toContainEqual([
      'setParameter',
      0x4d580001,
      linearToDb(0.5),
    ]);
    expect(engine.named('setParameter')).not.toContainEqual([
      'setParameter',
      0x4d580001,
      PFL_AUDITION_GAIN_DB,
    ]);
    expect(engine.named('setAutomationLane')).toContainEqual([
      'setAutomationLane',
      0x4d580001,
      expect.anything(),
    ]);
    expect(engine.named('setAutomationLane')).toContainEqual([
      'setAutomationLane',
      0x4d580002,
      expect.anything(),
    ]);
  });

  it('keeps return-solo buses and group buses silent despite fader automation', async () => {
    const doc = makeGroupDoc();
    doc.mixer!.buses.push({
      id: 'bus-b',
      name: 'B',
      gainDb: -3,
      automation: [{ param: 'faderDb', enabled: true, points: [{ ppq: 0, value: 12 }] }],
    } as (typeof doc.mixer.buses)[number]);
    doc.mixer!.buses[0].solo = true;
    doc.tracks[2].automation = [
      { param: 'faderDb', enabled: true, points: [{ ppq: 0, value: 12 }] },
    ];
    const engine = new FakeEngine();

    await renderProjectWithEngine(doc, renderOptions(engine));

    const buses = engine.named('setTrackBuses')[0][1] as Array<{ busId: number; gainDb: number }>;
    expect(buses.find((bus) => bus.busId === 1)?.gainDb).toBe(-6);
    expect(buses.find((bus) => bus.busId === 2)?.gainDb).toBe(-120);
    expect(buses.find((bus) => bus.busId === 3)?.gainDb).toBe(-120);
    expect(engine.named('setAutomationLane')).not.toContainEqual([
      'setAutomationLane',
      0x4d58fc01,
      expect.anything(),
    ]);
    expect(engine.named('setAutomationLane')).not.toContainEqual([
      'setAutomationLane',
      0x4d58fd01,
      expect.anything(),
    ]);
  });

  it('preflights and schedules audio in the exact discarded preroll window', async () => {
    const doc = makeDoc();
    doc.tracks[0].mute = true;
    doc.tracks[1].clips[0].startPpq = 1.5;
    doc.tracks[1].clips[0].lengthPpq = 2;
    const loadAudioAsset = vi.fn(async () => fakeAsset());
    const loadAudioAssetMeta = vi.fn(async () => fakeAsset().meta);
    const engine = new FakeEngine();

    const result = await renderProjectWithEngine(doc, {
      ...renderOptions(engine),
      loadAudioAsset,
      loadAudioAssetMeta,
      range: { startPpq: 2, endPpq: 3 },
      releaseTailSeconds: 0,
    });

    expect(result.totalFrames).toBe(SAMPLES_PER_PPQ);
    expect(loadAudioAssetMeta).toHaveBeenCalledWith('asset-1');
    expect(loadAudioAsset).toHaveBeenCalledWith('asset-1');
    const clips = engine.named('setClips')[0][1] as Array<{
      startPpq: number;
      lengthSamples: number;
    }>;
    expect(clips).toHaveLength(1);
    expect(clips[0]).toMatchObject({ startPpq: 1.5, lengthSamples: 48000 });
  });

  it('reports missing LUFS/true-peak measurements on streamed mixdowns', async () => {
    const result = await renderProjectWithEngine(makeDoc(), {
      deps: null,
      createEngine: () => new FakeEngine(),
      loadAudioAsset: async () => fakeAsset(),
      onMixdownChunk: () => undefined,
    });

    expect(result.channels[0]).toHaveLength(0);
    expect(result.report.lufs).toBeUndefined();
    expect(result.report.truePeakDb).toBeUndefined();
    expect(result.report.limitations).toContainEqual({
      kind: 'streaming-metering-unavailable',
      measurements: ['lufs', 'true-peak'],
    });
  });
});

describe('renderProjectWithEngine loudness metering', () => {
  it('meters the final stereo mix after mastering processors', async () => {
    const doc = makeDoc();
    doc.mixer = {
      ...doc.mixer,
      masteringChain: {
        processors: [{ processor: 'maximizer.truePeakLimiter', params: {}, enabled: true }],
      },
    };
    const processStereo = vi.fn((_name: string, left: Float32Array, right: Float32Array) => ({
      left: Float32Array.from(left, (value) => value * 0.5),
      right: Float32Array.from(right, (value) => value * 0.25),
    }));
    const interleavedLufs = vi.fn(() => ({
      integratedLufs: -8.5,
      momentaryLufs: -7.5,
      shortTermLufs: -8,
      loudnessRange: 3.25,
    }));
    const dynamicRangeDb = vi.fn(() => 8.75);

    const result = await renderProjectWithEngine(doc, {
      ...renderOptions(new FakeEngine()),
      deps: { mastering: { processStereo }, metering: { interleavedLufs, dynamicRangeDb } },
    });

    expect(interleavedLufs).toHaveBeenCalledTimes(1);
    expect(dynamicRangeDb).toHaveBeenCalledTimes(1);
    const [samples] = interleavedLufs.mock.calls[0];
    expect(samples[0]).toBeCloseTo(0.25 * 0.5, 5);
    expect(samples[1]).toBeCloseTo(0.25 * 0.25, 5);
    expect(result.report).toMatchObject({
      lufs: -8.5,
      momentaryLufs: -7.5,
      shortTermLufs: -8,
      loudnessRange: 3.25,
      dynamicRangeDb: 8.75,
    });
  });

  it('meters exported stems separately from the final mastered mix', async () => {
    const doc = makeDoc();
    doc.mixer = {
      ...doc.mixer,
      masteringChain: {
        processors: [{ processor: 'maximizer.truePeakLimiter', params: {}, enabled: true }],
      },
    };
    const processStereo = vi.fn((_name: string, left: Float32Array, right: Float32Array) => ({
      left: Float32Array.from(left, (value) => value * 0.25),
      right: Float32Array.from(right, (value) => value * 0.25),
    }));
    const interleavedLufs = vi.fn(() => -6.25);

    const result = await renderProjectWithEngine(doc, {
      ...renderOptions(new FakeEngine()),
      deps: { mastering: { processStereo }, metering: { interleavedLufs } },
      stems: true,
    });

    expect(interleavedLufs).toHaveBeenCalledTimes(3);
    const [firstStemSamples] = interleavedLufs.mock.calls[0];
    expect(firstStemSamples[0]).toBeCloseTo(0.25, 5);
    expect(firstStemSamples[1]).toBeCloseTo(0.25, 5);
    const [finalMixSamples] = interleavedLufs.mock.calls[2];
    expect(finalMixSamples[0]).toBeCloseTo(0.25 * 0.25, 5);
    expect(finalMixSamples[1]).toBeCloseTo(0.25 * 0.25, 5);
    expect(result.stems?.[0].channels[0][0]).toBeCloseTo(0.25, 5);
    expect(result.stems?.[0].report?.lufs).toBe(-6.25);
    expect(result.report.lufs).toBe(-6.25);
  });

  it('measures channel-weighted BS.1770 over the interleaved stereo mix', async () => {
    const engine = new FakeEngine();
    const interleavedLufs = vi.fn(() => -9.7);
    const integratedLufs = vi.fn(() => -12.7);
    const result = await renderProjectWithEngine(makeDoc(), {
      ...renderOptions(engine),
      deps: { mastering: null, metering: { interleavedLufs, integratedLufs } },
    });

    // The interleaved seam wins; the mono downmix fallback is never used.
    expect(integratedLufs).not.toHaveBeenCalled();
    expect(interleavedLufs).toHaveBeenCalledTimes(1);
    const [samples, channels, sampleRate] = interleavedLufs.mock.calls[0];
    expect(channels).toBe(2);
    expect(sampleRate).toBe(48000);
    expect(samples.length).toBe(result.totalFrames * 2);
    // Both channels carry the engine fill (0.25): L then R interleaved.
    expect(samples[0]).toBeCloseTo(0.25, 5);
    expect(samples[1]).toBeCloseTo(0.25, 5);
    expect(result.report.lufs).toBe(-9.7);
  });

  it('falls back to the mono downmix when only the legacy seam exists', async () => {
    const engine = new FakeEngine();
    const integratedLufs = vi.fn(() => -12.7);
    const result = await renderProjectWithEngine(makeDoc(), {
      ...renderOptions(engine),
      deps: { mastering: null, metering: { integratedLufs } },
    });

    expect(integratedLufs).toHaveBeenCalledTimes(1);
    const [mono] = integratedLufs.mock.calls[0];
    expect(mono.length).toBe(result.totalFrames);
    expect(mono[0]).toBeCloseTo(0.25, 5);
    expect(result.report.lufs).toBe(-12.7);
  });

  it('sums the clipping census over both channels and keeps the earliest run', async () => {
    const detectClipping = vi
      .fn()
      .mockReturnValueOnce({
        clippedSamples: 3,
        maxClippedPeak: 1.5,
        regions: [{ startSample: 96, length: 3 }],
      })
      .mockReturnValueOnce({
        clippedSamples: 1,
        maxClippedPeak: 1.1,
        regions: [{ startSample: 48, length: 1 }],
      });
    const result = await renderProjectWithEngine(makeDoc(), {
      ...renderOptions(new FakeEngine()),
      deps: { mastering: null, metering: { detectClipping } },
    });

    expect(detectClipping).toHaveBeenCalledTimes(2);
    expect(result.report.clipping).toEqual({
      clippedSamples: 4,
      clippingRatio: 4 / (result.totalFrames * 2),
      maxClippedPeak: 1.5,
      regionCount: 2,
      firstRegionStartSample: 48,
    });
  });

  it('records no clipping summary when neither channel clipped', async () => {
    const detectClipping = vi.fn(() => ({
      clippedSamples: 0,
      maxClippedPeak: 0,
      regions: [],
    }));
    const result = await renderProjectWithEngine(makeDoc(), {
      ...renderOptions(new FakeEngine()),
      deps: { mastering: null, metering: { detectClipping } },
    });

    // Absence is the signal, so an all-zero summary must not be recorded.
    expect(result.report.clipping).toBeUndefined();
  });

  it('keeps the report intact when clipping detection throws', async () => {
    const detectClipping = vi.fn(() => {
      throw new Error('detector unavailable');
    });
    const result = await renderProjectWithEngine(makeDoc(), {
      ...renderOptions(new FakeEngine()),
      deps: { mastering: null, metering: { detectClipping, integratedLufs: () => -11 } },
    });

    expect(result.report.clipping).toBeUndefined();
    expect(result.report.lufs).toBe(-11);
  });
});

/** Fake baked freeze asset: half a second of stereo at the render rate. */
function frozenAsset(frames = 24000): LoadedAudioAsset {
  return {
    meta: {
      id: 'frozen-1',
      name: 'baked.wav',
      sampleRate: 48000,
      numChannels: 2,
      numFrames: frames,
    },
    channels: [new Float32Array(frames).fill(0.75), new Float32Array(frames).fill(0.75)],
  };
}

describe('renderProjectWithEngine with frozen tracks', () => {
  /** Asset loader serving the baked asset next to the regular clip asset. */
  function loadFrozenOrClipAsset() {
    return vi.fn(async (assetId: string) => (assetId === 'frozen-1' ? frozenAsset() : fakeAsset()));
  }

  it('plays a frozen audio track from its baked asset instead of its own clips and strip', async () => {
    const doc = makeDoc();
    doc.tracks[1].frozen = { assetId: 'frozen-1' };
    // Give the frozen track strip DSP that must NOT reach the engine (it is
    // already baked into the frozen render).
    (doc.tracks[1].mixer as { inserts: unknown[] }).inserts = [
      { processor: 'dynamics.compressor', params: {}, enabled: true },
    ];
    const engine = new FakeEngine();
    const loadAudioAsset = loadFrozenOrClipAsset();
    await renderProjectWithEngine(doc, { deps: null, createEngine: () => engine, loadAudioAsset });

    // Only the baked asset loads; the track's own clip asset is never touched.
    expect(loadAudioAsset.mock.calls.map(([assetId]) => assetId)).toEqual(['frozen-1']);

    // One engine clip: the baked render at the timeline start, full length,
    // unity gain (the live fader applies on top).
    const clips = engine.named('setClips')[0][1] as Array<{
      trackId: number;
      channels: Float32Array[];
      startPpq: number;
      lengthSamples: number;
      gain?: number;
    }>;
    expect(clips).toHaveLength(1);
    expect(clips[0]).toMatchObject({ trackId: 2, startPpq: 0, lengthSamples: 24000, gain: 1 });
    expect(clips[0].channels[0][0]).toBeCloseTo(0.75, 5);

    // The frozen lane gets no strip JSON; the unfrozen MIDI track still plays.
    expect(engine.named('setTrackStripJson')).toEqual([]);
    expect(engine.named('setMidiClips')).toHaveLength(1);
  });

  it('uses the offline WASM resampler for a frozen asset at another sample rate', async () => {
    const doc = makeDoc();
    doc.tracks[1].frozen = { assetId: 'frozen-1' };
    const source = frozenAsset(12000);
    source.meta.sampleRate = 24000;
    const engine = new FakeEngine();

    await renderProjectWithEngine(doc, {
      deps: null,
      createEngine: () => engine,
      resampleAudio: resample,
      loadAudioAsset: async (assetId) => (assetId === 'frozen-1' ? source : fakeAsset()),
    });

    expect(resample).toHaveBeenCalledTimes(source.channels.length);
    expect(resample).toHaveBeenCalledWith(expect.any(Float32Array), 24000, 48000);
    const clips = engine.named('setClips')[0][1] as Array<{ lengthSamples: number }>;
    expect(clips[0].lengthSamples).toBe(24000);
  });

  it('renders frozen audio assets audibly through live lane and master levels', async () => {
    const doc = makeDoc();
    doc.tracks[1].frozen = { assetId: 'frozen-1' };
    const result = await renderProjectWithEngine(doc, {
      ...renderOptions(new AudibilityEngine()),
      loadAudioAsset: loadFrozenOrClipAsset(),
    });
    const frozenLevel = 0.75 * defaultAudioLaneGain() * defaultMasterGain();

    expect(result.channels[0][0]).toBeCloseTo(defaultMidiLevel(96) + frozenLevel, 5);
    expect(result.channels[0][SAMPLES_PER_PPQ - 1]).toBeCloseTo(frozenLevel, 5);
    expect(result.channels[0][SAMPLES_PER_PPQ]).toBeCloseTo(0, 5);
  });

  it('keeps project-range renders open until the baked frozen asset ends', async () => {
    const doc = makeDoc();
    doc.tracks[0].clips = [];
    doc.tracks[1].clips = [{ ...doc.tracks[1].clips[0], lengthPpq: 1 }];
    doc.tracks[1].frozen = { assetId: 'frozen-1' };

    const result = await renderProjectWithEngine(doc, {
      deps: null,
      loadAudioAsset: vi.fn(async (assetId: string) =>
        assetId === 'frozen-1' ? frozenAsset(4 * SAMPLES_PER_PPQ) : fakeAsset(),
      ),
      createEngine: () => new AudibilityEngine(),
      releaseTailSeconds: 0,
    });

    expect(result.totalFrames).toBe(4 * SAMPLES_PER_PPQ);
    expect(result.channels[0][result.totalFrames - 1]).toBeCloseTo(
      0.75 * defaultAudioLaneGain() * defaultMasterGain(),
      5,
    );
  });

  it('a frozen MIDI track contributes no MIDI schedules', async () => {
    const doc = makeDoc();
    doc.tracks[0].frozen = { assetId: 'frozen-1' };
    doc.tracks[0].instrument = { kind: 'sf2', fontId: 'font-a', bank: 1, program: 5 };
    const engine = new FakeEngine();
    const loadFont = vi.fn(async () => new Uint8Array([1, 2, 3]));
    await renderProjectWithEngine(doc, {
      deps: null,
      createEngine: () => engine,
      loadAudioAsset: loadFrozenOrClipAsset(),
      loadFont,
    });

    // The only MIDI clip lives on the frozen track: nothing is scheduled.
    expect(engine.named('setMidiClips')).toEqual([]);
    // Frozen MIDI plays only its baked asset; it must not bind a synth/SF2 or
    // touch the engine's global SoundFont slot.
    expect(loadFont).not.toHaveBeenCalled();
    expect(engine.named('loadSoundFont')).toEqual([]);
    expect(engine.named('setSf2Instrument')).toEqual([]);
    expect(engine.named('setSynthInstrument')).toEqual([]);
    // The baked render plays on lane 1, the audio track keeps its own clip.
    const clips = engine.named('setClips')[0][1] as Array<Record<string, unknown>>;
    expect(clips).toHaveLength(2);
    expect(clips[0]).toMatchObject({ trackId: 1, startPpq: 0, gain: 1 });
    expect(clips[1]).toMatchObject({ trackId: 2, startPpq: 2 });
  });

  it('keeps a frozen track silent when its baked asset is empty', async () => {
    const doc = makeDoc();
    doc.tracks[1].frozen = { assetId: 'frozen-empty' };
    const engine = new FakeEngine();
    await renderProjectWithEngine(doc, {
      deps: null,
      createEngine: () => engine,
      loadAudioAsset: async (assetId: string) =>
        assetId === 'frozen-empty' ? frozenAsset(0) : fakeAsset(),
    });

    // The frozen track's own clip is skipped, and the empty baked render is
    // not sent to the engine as a zero-length clip.
    expect(engine.named('setClips')).toEqual([]);
    // The unfrozen MIDI track still plays through MIDI scheduling.
    expect(engine.named('setMidiClips')).toHaveLength(1);
  });

  it('freezeTrackIndex renders one isolated pre-fader pass', async () => {
    const doc = makeDoc();
    // Automation on the frozen candidate must stay live (not rendered).
    doc.tracks[1].automation = [
      { param: 'faderDb', enabled: true, points: [{ ppq: 0, value: -12 }] },
      { param: 'pan', enabled: true, points: [{ ppq: 0, value: 1 }] },
      { param: 'insert:0:thresholdDb', enabled: true, points: [{ ppq: 0, value: -18 }] },
    ];
    // Its insert chain IS part of the pre-fader signal and must render.
    (doc.tracks[1].mixer as { inserts: unknown[] }).inserts = [
      { processor: 'dynamics.compressor', params: {}, enabled: true },
    ];
    // A master insert chain must be skipped by the freeze pass.
    (doc.mixer as { master: { inserts: unknown[] } }).master.inserts = [
      { processor: 'dynamics.limiter', params: {}, enabled: true },
    ];

    const engines: FakeEngine[] = [];
    const result = await renderProjectWithEngine(doc, {
      deps: null,
      loadAudioAsset: async () => fakeAsset(),
      createEngine: () => {
        const engine = new FakeEngine();
        engines.push(engine);
        return engine;
      },
      freezeTrackIndex: 1,
    });

    // A freeze render is exactly one pass on one engine.
    expect(engines).toHaveLength(1);
    const engine = engines[0];
    expect(engine.destroyed).toBe(true);

    // The frozen lane's sends are stripped (they stay live on the track).
    expect(engine.named('setTrackLanes')[0][1]).toEqual([{ trackId: 1 }, { trackId: 2 }]);

    // Pre-fader: the lane renders at unity gain, centered.
    const params = new Map(engine.named('setParameter').map(([, id, value]) => [id, value]));
    expect(params.get(0x4d580101)).toBe(0);
    expect(params.get(0x4d580102)).toBe(0);

    // No master strip scene and no master levels.
    expect(engine.named('setMasterStripJson')).toEqual([]);
    expect(params.has(0x4d58ff01)).toBe(false);
    expect(params.has(0x4d58ff02)).toBe(false);

    // The frozen lane's faderDb/pan automation is excluded; insert automation
    // still renders into the baked pre-fader DSP. Other lanes keep theirs and
    // master automation is skipped with the master levels.
    const laneIds = new Set(engine.named('setAutomationLane').map(([, id]) => id));
    expect(laneIds.has(0x4d580101)).toBe(false);
    expect(laneIds.has(0x4d580102)).toBe(false);
    expect(laneIds.has(0x4d580001)).toBe(true);
    expect(laneIds.has(0x4d58ff02)).toBe(false);
    expect(engine.named('resolveTrackInsertAutomationId')).toEqual([
      ['resolveTrackInsertAutomationId', 2, 0, 'thresholdDb'],
    ]);

    // Every other lane is muted; the frozen lane stays audible.
    expect(engine.named('setSoloMute')).toEqual([
      ['setSoloMute', 0, false, true],
      ['setSoloMute', 1, false, false],
    ]);

    // The track's own insert chain renders into the freeze (pre-fader DSP).
    expect(engine.named('setTrackStripJson').map(([, trackId]) => trackId)).toEqual([2]);

    // The result carries the single pass output and its peak.
    expect(result.totalFrames).toBe(4 * 24000 + 2 * 48000);
    expect(result.channels[0]).toHaveLength(result.totalFrames);
    expect(result.channels[0][0]).toBeCloseTo(0.25, 5);
    expect(result.channels[1][result.totalFrames - 1]).toBeCloseTo(0.25, 5);
    expect(result.report.peakDb).toBeCloseTo(20 * Math.log10(0.25), 5);
  });

  it('freezeTrackIndex excludes track fader automation from the audible pre-fader render', async () => {
    const doc = makeDoc();
    doc.tracks[0].mute = true;
    doc.tracks[1].automation = [
      {
        param: 'faderDb',
        enabled: true,
        points: [
          { ppq: 0, value: -48 },
          { ppq: 2, value: 0 },
        ],
      },
    ];

    const result = await renderProjectWithEngine(doc, {
      ...renderOptions(new AudibilityEngine()),
      freezeTrackIndex: 1,
    });

    // The audio clip sample is 0.5 and clip gain is 0.8. The track fader,
    // its +2 dB strip trim and master gain are intentionally excluded.
    expect(result.channels[0][2 * SAMPLES_PER_PPQ]).toBeCloseTo(0.5 * 0.8, 5);
  });

  it('freezeTrackIndex strips group output routing from the frozen lane', async () => {
    const doc = makeGroupDoc();
    const engine = new FakeEngine();

    await renderProjectWithEngine(doc, {
      ...renderOptions(engine),
      freezeTrackIndex: 1,
    });

    // The Drums lane normally routes to the Drum Bus group output, but a
    // pre-fader freeze must not bake that downstream group bus into the asset.
    expect(engine.named('setTrackLanes')[0][1]).toEqual([
      { trackId: 1 },
      { trackId: 2 },
      { trackId: 3 },
    ]);
  });

  it('rejects an out-of-range freeze track index', async () => {
    for (const freezeTrackIndex of [-1, 2, 0.5]) {
      await expect(
        renderProjectWithEngine(makeDoc(), {
          ...renderOptions(new FakeEngine()),
          freezeTrackIndex,
        }),
      ).rejects.toThrow(RangeError);
    }
  });

  it('rejects freezing a group track at the render layer', async () => {
    await expect(
      renderProjectWithEngine(makeGroupDoc(), {
        ...renderOptions(new FakeEngine()),
        freezeTrackIndex: 2,
      }),
    ).rejects.toThrow(/Group tracks cannot be frozen/);
  });
});

/** Document with a group track (index 2) that the audio track routes into. */
function makeGroupDoc(): ProjectDocument {
  const doc = makeDoc();
  const tracks = doc.tracks as unknown as Array<Record<string, unknown>>;
  tracks.push({
    name: 'Drum Bus',
    color: '#0af',
    kind: 'group',
    mute: false,
    solo: false,
    volume: 0.5,
    pan: 0,
    clips: [],
    mixer: {
      gainDb: -2,
      pan: 0,
      sends: [],
      inserts: [
        { processor: 'dynamics.compressor', params: { thresholdDb: -20 }, enabled: true },
        { processor: 'saturation.tape', params: { drive: 0.4 }, enabled: false },
      ],
    },
  });
  tracks[1].groupIndex = 2;
  return doc;
}

describe('renderProjectWithEngine with group tracks and sidechains', () => {
  it('renders grouped child stems independently for mix assistant analysis', async () => {
    const result = await renderProjectWithEngine(neutralMixDocument(makeGroupDoc()), {
      deps: null,
      loadAudioAsset: async () => fakeAsset(),
      createEngine: () => new FakeEngine(),
      stems: true,
    });
    expect(result.stems?.map((stem) => stem.trackIndex)).toContain(1);
  });

  it('binds return, group and master inserts to document track and bus keys', async () => {
    const doc = makeGroupDoc();
    if (!doc.mixer) throw new Error('missing mixer');
    doc.mixer.buses[0].strip = {
      gainDb: 0,
      pan: 0,
      sends: [],
      inserts: [
        {
          processor: 'dynamics.duckingProcessor',
          params: {},
          enabled: true,
          sidechainSourceIndex: 1,
        } as unknown as InsertSlot,
      ],
    };
    doc.mixer.buses.push({
      id: 'bus-b',
      name: 'B',
      gainDb: 0,
      strip: {
        gainDb: 0,
        pan: 0,
        sends: [],
        inserts: [
          {
            processor: 'dynamics.duckingProcessor',
            params: {},
            enabled: true,
            sidechainSourceBusId: 'bus-a',
          } as unknown as InsertSlot,
        ],
      },
    });
    doc.tracks[2].mixer = {
      ...(doc.tracks[2].mixer ?? { gainDb: 0, pan: 0, sends: [], inserts: [] }),
      inserts: [
        {
          processor: 'dynamics.duckingProcessor',
          params: {},
          enabled: true,
          sidechainSourceIndex: 1,
        } as unknown as InsertSlot,
      ],
    };
    doc.mixer.master.inserts = [
      {
        processor: 'dynamics.duckingProcessor',
        params: {},
        enabled: true,
        sidechainSourceGroupTrackIndex: 2,
      } as unknown as InsertSlot,
    ];
    const engine = new FakeEngine();
    await renderProjectWithEngine(doc, renderOptions(engine));
    expect(engine.named('setBusSidechain')).toEqual([
      ['setBusSidechain', 1, 0, 0, 2],
      ['setBusSidechain', 2, 0, 1, 1],
      ['setBusSidechain', 3, 0, 0, 2],
    ]);
    expect(engine.named('setMasterSidechain')).toEqual([['setMasterSidechain', 0, 1, 3]]);
  });

  it('binds a keyed bus insert at its compacted index on an older engine', async () => {
    const doc = makeDoc();
    if (!doc.mixer) throw new Error('missing mixer');
    doc.mixer.buses[0].strip = {
      gainDb: 0,
      pan: 0,
      sends: [],
      inserts: [
        { processor: 'saturation.tape', params: {}, enabled: false },
        {
          processor: 'dynamics.duckingProcessor',
          params: {},
          enabled: true,
          sidechainSourceIndex: 0,
        } as unknown as InsertSlot,
      ],
    };
    const engine = new FakeEngine();
    await renderProjectWithEngine(doc, renderOptions(engine));
    expect(engine.named('setBusSidechain')).toEqual([['setBusSidechain', 1, 0, 0, 1]]);
  });

  it('declares return and group bus sends and outputs with surround width', async () => {
    const doc = makeGroupDoc();
    const buses = doc.mixer?.buses;
    if (!buses) throw new Error('missing mixer buses');
    buses.push({ id: 'bus-b', name: 'B', gainDb: 0 });
    buses[0].channelLayout = '5.1';
    buses[0].strip = {
      gainDb: 0,
      pan: 0,
      inserts: [],
      sends: [{ busId: 'bus-b', levelDb: -9, enabled: true, timing: 'preFader' }],
      outputBusId: 'bus-b',
    };
    doc.tracks[2].mixer = {
      ...(doc.tracks[2].mixer ?? { gainDb: 0, pan: 0, inserts: [], sends: [] }),
      sends: [{ busId: 'bus-b', levelDb: -12, enabled: true }],
      outputBusId: 'bus-b',
    };
    const engine = new FakeEngine();
    await renderProjectWithEngine(doc, renderOptions(engine));
    const declared = engine.named('setTrackBuses')[0][1] as Array<Record<string, unknown>>;
    expect(declared).toEqual([
      {
        busId: 1,
        gainDb: -6,
        channelLayout: 2,
        outputBusId: 2,
        sends: [{ busId: 2, levelDb: -9, enabled: true, sendTiming: 'preFader' }],
      },
      { busId: 2, gainDb: 0 },
      {
        busId: 3,
        gainDb: expect.any(Number),
        outputBusId: 2,
        sends: [{ busId: 2, levelDb: -12, enabled: true }],
      },
    ]);
  });

  it('declares the group bus after the send buses and routes members through it', async () => {
    const engine = new FakeEngine();
    await renderProjectWithEngine(makeGroupDoc(), renderOptions(engine));

    const buses = engine.named('setTrackBuses')[0][1] as Array<{ busId: number; gainDb: number }>;
    expect(buses).toHaveLength(2);
    expect(buses[0]).toEqual({ busId: 1, gainDb: -6 });
    expect(buses[1].busId).toBe(2);
    // Combined audible group level: track volume in dB plus the strip gain.
    expect(buses[1].gainDb).toBeCloseTo(linearToDb(0.5) - 2, 5);

    expect(engine.named('setTrackLanes')[0][1]).toEqual([
      { trackId: 1 },
      { trackId: 2, sends: [{ busId: 1, levelDb: -9, enabled: true }], outputBusId: 2 },
      { trackId: 3 },
    ]);
  });

  it('does not force muted group members into a group stem', async () => {
    const doc = makeGroupDoc();
    doc.tracks[1].mute = true;
    const engines: FakeEngine[] = [];

    const result = await renderProjectWithEngine(doc, {
      deps: null,
      loadAudioAsset: async () => fakeAsset(),
      createEngine: () => {
        const engine = new FakeEngine();
        engines.push(engine);
        return engine;
      },
      stems: true,
    });

    expect(result.stems?.map((stem) => stem.trackIndex)).toEqual([0, 2]);
    const groupStemPass = engines[2];
    // The muted Drums member must stay muted even though the Drum Bus stem is
    // being isolated. Previously it was added to stemIndices and leaked audio.
    expect(groupStemPass.named('setSoloMute')).toEqual([
      ['setSoloMute', 0, false, true],
      ['setSoloMute', 1, false, true],
    ]);
  });

  it('does not force VCA-muted members into a group stem, even with fader automation', async () => {
    const doc = makeGroupDoc();
    doc.tracks[1].vcaId = 'muted-members';
    doc.tracks[1].automation = [
      {
        param: 'faderDb',
        enabled: true,
        points: [
          { ppq: 0, value: 12 },
          { ppq: 4, value: 12, curve: 'hold' },
        ],
      },
    ];
    if (doc.mixer) {
      doc.mixer.vcaGroups = [{ id: 'muted-members', name: 'Muted members', gainDb: 6, mute: true }];
    }

    const result = await renderProjectWithEngine(doc, {
      deps: null,
      loadAudioAsset: async () => fakeAsset(),
      createEngine: () => new AudibilityEngine(),
      stems: true,
    });

    const groupStem = result.stems?.find((stem) => stem.trackIndex === 2);
    expect(groupStem?.channels[0][2 * SAMPLES_PER_PPQ]).toBeCloseTo(0, 5);
    expect(groupStem?.channels[1][2 * SAMPLES_PER_PPQ]).toBeCloseTo(0, 5);
  });

  it('renders routed group members into a group stem audibly', async () => {
    const result = await renderProjectWithEngine(makeGroupDoc(), {
      deps: null,
      loadAudioAsset: async () => fakeAsset(),
      createEngine: () => new AudibilityEngine(),
      stems: true,
    });

    const groupStem = result.stems?.find((stem) => stem.trackIndex === 2);
    expect(groupStem?.channels[0][0]).toBeCloseTo(0, 5);
    expect(groupStem?.channels[0][2 * SAMPLES_PER_PPQ]).toBeCloseTo(
      0.5 * 0.8 * defaultAudioLaneGain(),
      5,
    );
  });

  it('expands a soloed group track to its routed member lanes in the mix pass', async () => {
    const doc = makeGroupDoc();
    doc.tracks[2].solo = true;

    const result = await renderProjectWithEngine(doc, {
      deps: null,
      loadAudioAsset: async () => fakeAsset(),
      createEngine: () => new AudibilityEngine(),
    });

    expect(result.channels[0][0]).toBeCloseTo(0, 5);
    expect(result.channels[0][2 * SAMPLES_PER_PPQ]).toBeCloseTo(
      0.5 * 0.8 * defaultAudioLaneGain() * defaultMasterGain(),
      5,
    );
  });

  it('exports only the group stem when its routed group is soloed', async () => {
    const doc = makeGroupDoc();
    doc.tracks[2].solo = true;
    const engines: FakeEngine[] = [];

    const result = await renderProjectWithEngine(doc, {
      deps: null,
      loadAudioAsset: async () => fakeAsset(),
      createEngine: () => {
        const engine = new FakeEngine();
        engines.push(engine);
        return engine;
      },
      stems: true,
    });

    expect(result.stems?.map((stem) => stem.trackIndex)).toEqual([2]);
    expect(result.stems?.map((stem) => stem.name)).toEqual(['Drum Bus']);
    expect(engines).toHaveLength(2);
  });

  it('exports the routed group stem without duplicating its soloed child', async () => {
    const doc = makeGroupDoc();
    doc.tracks[1].solo = true;

    const result = await renderProjectWithEngine(doc, {
      deps: null,
      loadAudioAsset: async () => fakeAsset(),
      createEngine: () => new AudibilityEngine(),
      stems: true,
    });

    expect(result.stems?.map((stem) => stem.trackIndex)).toEqual([2]);
    const groupStem = result.stems?.find((stem) => stem.trackIndex === 2);
    expect(groupStem?.channels[0][2 * SAMPLES_PER_PPQ]).toBeCloseTo(
      0.5 * 0.8 * defaultAudioLaneGain(),
      5,
    );
  });

  it('includes a group stem when its routed member is solo-safe', async () => {
    const doc = makeGroupDoc();
    doc.tracks[0].solo = true;
    doc.tracks[1].soloSafe = true;

    const result = await renderProjectWithEngine(doc, {
      deps: null,
      loadAudioAsset: async () => fakeAsset(),
      createEngine: () => new AudibilityEngine(),
      stems: true,
    });

    expect(result.stems?.map((stem) => stem.trackIndex)).toEqual([0, 2]);
    const groupStem = result.stems?.find((stem) => stem.trackIndex === 2);
    expect(groupStem?.channels[0][2 * SAMPLES_PER_PPQ]).toBeGreaterThan(0);
  });

  it('maps group-track automation to the group bus in export', async () => {
    const doc = makeGroupDoc();
    doc.tracks[2].automation = [
      { param: 'faderDb', enabled: true, points: [{ ppq: 0, value: -10 }] },
      { param: 'insert:0:thresholdDb', enabled: true, points: [{ ppq: 0, value: -24 }] },
    ];

    const engine = new FakeEngine();
    await renderProjectWithEngine(doc, renderOptions(engine));

    expect(engine.named('setAutomationLane')).toContainEqual([
      'setAutomationLane',
      0x4d58fc01,
      [{ ppq: 0, value: -10, curveToNext: 0 }],
    ]);
    expect(engine.named('resolveBusInsertAutomationId')).toContainEqual([
      'resolveBusInsertAutomationId',
      2,
      0,
      'thresholdDb',
    ]);
    expect(engine.named('resolveTrackInsertAutomationId')).not.toContainEqual([
      'resolveTrackInsertAutomationId',
      3,
      0,
      'thresholdDb',
    ]);
  });

  it('suppresses muted group fader automation at the silence floor in export', async () => {
    const doc = makeGroupDoc();
    doc.tracks[2].mute = true;
    doc.tracks[2].automation = [
      {
        param: 'faderDb',
        enabled: true,
        points: [
          { ppq: 0, value: -10 },
          { ppq: 4, value: 0, curve: 'hold' },
        ],
      },
    ];

    const engine = new FakeEngine();
    await renderProjectWithEngine(doc, renderOptions(engine));

    const buses = engine.named('setTrackBuses')[0][1] as Array<{ busId: number; gainDb: number }>;
    expect(buses.find((bus) => bus.busId === 2)?.gainDb).toBe(-120);
    expect(engine.named('setAutomationLane')).not.toContainEqual([
      'setAutomationLane',
      0x4d58fc01,
      expect.anything(),
    ]);
  });

  it('suppresses VCA-muted group fader automation at the silence floor in export', async () => {
    const doc = makeGroupDoc();
    doc.tracks[2].vcaId = 'vca-muted';
    if (doc.mixer) {
      doc.mixer.vcaGroups = [{ id: 'vca-muted', name: 'Muted', gainDb: 6, mute: true }];
    }
    doc.tracks[2].automation = [
      { param: 'faderDb', enabled: true, points: [{ ppq: 0, value: 12 }] },
    ];

    const engine = new FakeEngine();
    await renderProjectWithEngine(doc, renderOptions(engine));

    const buses = engine.named('setTrackBuses')[0][1] as Array<{ busId: number; gainDb: number }>;
    expect(buses.find((bus) => bus.busId === 2)?.gainDb).toBe(-120);
    expect(engine.named('setAutomationLane')).not.toContainEqual([
      'setAutomationLane',
      0x4d58fc01,
      expect.anything(),
    ]);
  });

  it('keeps muted routed members silent in the audible group stem', async () => {
    const doc = makeGroupDoc();
    doc.tracks[1].mute = true;
    const result = await renderProjectWithEngine(doc, {
      deps: null,
      loadAudioAsset: async () => fakeAsset(),
      createEngine: () => new AudibilityEngine(),
      stems: true,
    });

    const groupStem = result.stems?.find((stem) => stem.trackIndex === 2);
    expect(groupStem?.channels[0][2 * SAMPLES_PER_PPQ]).toBeCloseTo(0, 5);
    expect(groupStem?.channels[1][2 * SAMPLES_PER_PPQ]).toBeCloseTo(0, 5);
  });

  it('folds a group track VCA offset into the exported group bus gain', async () => {
    const doc = makeGroupDoc();
    (doc.mixer as { vcaGroups?: unknown }).vcaGroups = [
      { id: 'vca-1', name: 'Group VCA', gainDb: -6 },
    ];
    (doc.tracks[2] as { vcaId?: string }).vcaId = 'vca-1';

    const engine = new FakeEngine();
    await renderProjectWithEngine(doc, renderOptions(engine));

    const buses = engine.named('setTrackBuses')[0][1] as Array<{ busId: number; gainDb: number }>;
    expect(buses[1].gainDb).toBeCloseTo(linearToDb(0.5) - 2 - 6, 5);
  });

  it('sends only the enabled group inserts to the bus strip and keeps the group lane neutral', async () => {
    const engine = new FakeEngine();
    await renderProjectWithEngine(makeGroupDoc(), renderOptions(engine));

    const busStrips = engine.named('setBusStripJson');
    expect(busStrips).toHaveLength(1);
    expect(busStrips[0][1]).toBe(2);
    expect(JSON.parse(busStrips[0][2] as string)).toEqual({
      version: 1,
      strips: [],
      buses: [
        {
          id: 'bus-2',
          role: 'submix',
          inserts: [
            { slot: 'pre', processor: 'dynamics.compressor', params: { thresholdDb: -20 } },
          ],
        },
      ],
      connections: [],
    });

    // The group's lane stays silent: no lane strip, fader/pan, or solo/mute.
    expect(engine.named('setTrackStripJson').filter(([, trackId]) => trackId === 3)).toEqual([]);
    const params = new Map(engine.named('setParameter').map(([, id, value]) => [id, value]));
    expect(params.has(0x4d580201)).toBe(false);
    expect(params.has(0x4d580202)).toBe(false);
    expect(engine.named('setSoloMute')).toEqual([
      ['setSoloMute', 0, false, false],
      ['setSoloMute', 1, false, false],
    ]);
  });

  it('exports group-bus pan and EQ through the same bus strip declaration', async () => {
    const doc = makeGroupDoc();
    const group = doc.tracks[2] as unknown as {
      mixer: Record<string, unknown>;
    };
    group.mixer.pan = -0.4;
    group.mixer.panLaw = 'const6dB';
    group.mixer.panMode = 'stereoPan';
    group.mixer.eq = {
      enabled: true,
      bands: [{ enabled: true, type: 'peak', frequencyHz: 800, gainDb: 2, q: 1 }],
    };

    const engine = new FakeEngineWithBusEq();
    await renderProjectWithEngine(doc, renderOptions(engine));

    const scene = JSON.parse(engine.named('setBusStripJson')[0][2] as string);
    expect(scene.buses[0].id).toBe('bus-2');
    expect(scene.buses[0]).toMatchObject({
      pan: -0.4,
      panLaw: 2,
      panMode: 1,
      eq: {
        enabled: true,
        bands: [{ enabled: true, type: 'peak', frequencyHz: 800, gainDb: 2, q: 1 }],
      },
    });
  });

  it('floors a muted group bus to silence and skips the bus strip without enabled inserts', async () => {
    const doc = makeGroupDoc();
    const group = doc.tracks[2] as unknown as {
      mute: boolean;
      mixer: { inserts: Array<{ enabled: boolean }> };
    };
    group.mute = true;
    for (const slot of group.mixer.inserts) slot.enabled = false;
    const engine = new FakeEngine();
    await renderProjectWithEngine(doc, renderOptions(engine));

    const buses = engine.named('setTrackBuses')[0][1] as Array<{ busId: number; gainDb: number }>;
    expect(buses[1].gainDb).toBe(-120);
    expect(engine.named('setBusStripJson')).toEqual([]);
  });

  it('does not send disabled track or master EQ bands to the offline engine', async () => {
    const doc = makeDoc();
    const trackMixer = doc.tracks[1].mixer as NonNullable<
      ProjectDocument['tracks'][number]['mixer']
    >;
    trackMixer.inserts = [{ processor: 'dynamics.compressor', params: {}, enabled: true }];
    trackMixer.eq = {
      enabled: false,
      bands: [{ type: 'peak', frequency: 1000, gainDb: 9, q: 1 }],
    };
    const master = doc.mixer?.master as NonNullable<ProjectDocument['mixer']>['master'];
    master.inserts = [{ processor: 'dynamics.limiter', params: {}, enabled: true }];
    master.eq = {
      enabled: false,
      bands: [{ type: 'highShelf', frequency: 8000, gainDb: 6, q: 0.7 }],
    };

    const engine = new FakeEngine();
    await renderProjectWithEngine(doc, renderOptions(engine));

    expect(engine.named('setTrackStripJson').map(([, trackId]) => trackId)).toContain(2);
    expect(engine.named('setMasterStripJson')).toHaveLength(1);
    expect(engine.named('setTrackStripEqBandJson')).toEqual([]);
    expect(engine.named('setMasterStripEqBandJson')).toEqual([]);
  });

  it('sends send-bus strip DSP when trim, width, or polarity is active without inserts', async () => {
    const doc = makeDoc();
    if (doc.mixer) {
      doc.mixer.buses[0].strip = {
        inputTrimDb: -3,
        width: 0,
        polarityInvertLeft: true,
        inserts: [],
        sends: [],
      };
    }

    const engine = new FakeEngine();
    await renderProjectWithEngine(doc, renderOptions(engine));

    const busStrips = engine.named('setBusStripJson');
    expect(busStrips).toHaveLength(1);
    expect(busStrips[0][1]).toBe(1);
    expect(JSON.parse(busStrips[0][2] as string)).toEqual({
      version: 1,
      strips: [],
      buses: [
        {
          id: 'bus-1',
          role: 'submix',
          inserts: [],
          inputTrimDb: -3,
          width: 0,
          polarityInvertLeft: true,
        },
      ],
      connections: [],
    });
  });

  it('binds positional insert sidechains to lane ids and drops invalid references', async () => {
    const doc = makeGroupDoc();
    const drums = doc.tracks[1] as unknown as { mixer: { inserts: unknown[] } };
    drums.mixer.inserts = [
      // Valid: keyed from track index 0 (engine lane id 1).
      { processor: 'dynamics.compressor', params: {}, enabled: true, sidechainSourceIndex: 0 },
      // Self reference: dropped.
      { processor: 'dynamics.compressor', params: {}, enabled: true, sidechainSourceIndex: 1 },
      // Out of range: dropped.
      { processor: 'dynamics.compressor', params: {}, enabled: true, sidechainSourceIndex: 9 },
      // Not an integer index: dropped.
      { processor: 'dynamics.compressor', params: {}, enabled: true, sidechainSourceIndex: 0.5 },
    ];
    // Group-track inserts never bind a lane sidechain (they live on a bus).
    const group = doc.tracks[2] as unknown as {
      mixer: { inserts: Array<Record<string, unknown>> };
    };
    group.mixer.inserts[0].sidechainSourceIndex = 0;

    const engine = new FakeEngine();
    await renderProjectWithEngine(doc, renderOptions(engine));
    expect(engine.named('setLaneSidechain')).toEqual([['setLaneSidechain', 2, 0, 1]]);
  });
});

describe('renderProjectWithEngine mixer parity with live playback', () => {
  /** Drums lane (track index 1) fader/pan parameter ids. */
  const drumsFader = 0x4d580101;

  it('normalizes the same document into equivalent live and offline mixer commands', async () => {
    const doc = makeDoc();
    doc.tracks[0].volume = 0.5;
    doc.tracks[0].mixer = {
      gainDb: 0,
      pan: 0.25,
      inserts: [],
      sends: [],
      panLaw: 'const6dB',
      panMode: 'dualPan',
      dualPan: { left: -0.5, right: 0.75 },
      channelDelaySamples: 12,
    };
    const liveEngine = {
      setTrackLanes: vi.fn(),
      setStripGain: vi.fn(),
      setStripPan: vi.fn(),
      setSoloMute: vi.fn(),
      setTrackStripChannelDelaySamples: vi.fn(),
      setTrackStripPanLaw: vi.fn(),
      setTrackStripPanMode: vi.fn(),
      setTrackStripDualPan: vi.fn(),
    };
    const liveTracks: EditorTrack[] = doc.tracks.map((track, index) => ({
      id: index + 1,
      name: track.name,
      color: track.color,
      kind: track.kind,
      mute: track.mute,
      solo: track.solo,
      soloSafe: track.soloSafe,
      vcaId: track.vcaId,
      volume: track.volume,
      pan: track.pan,
      order: index,
      mixer: track.mixer,
      ...(track.groupIndex === undefined ? {} : { groupId: track.groupIndex + 1 }),
    }));
    createMixerSync({ engine: liveEngine } as unknown as EngineHandle).sync(
      liveTracks,
      doc.mixer!.master,
    );

    const offline = new FakeEngine();
    await renderProjectWithEngine(doc, renderOptions(offline));
    const offlineLanes = offline.named('setTrackLanes')[0][1] as Array<{ trackId: number }>;
    const offlineTrackId = (laneIndex: number) => offlineLanes[laneIndex].trackId;
    const offlineState = new Map<number, Record<string, unknown>>();
    const liveState = new Map<number, Record<string, unknown>>();
    const stateFor = (map: Map<number, Record<string, unknown>>, trackId: number) => {
      const state = map.get(trackId) ?? {};
      map.set(trackId, state);
      return state;
    };
    for (const [trackId, gainDb] of liveEngine.setStripGain.mock.calls) {
      if (typeof trackId === 'number') stateFor(liveState, trackId).gainDb = gainDb;
    }
    for (const [trackId, pan] of liveEngine.setStripPan.mock.calls) {
      if (typeof trackId === 'number') stateFor(liveState, trackId).pan = pan;
    }
    for (const [trackId, solo, mute] of liveEngine.setSoloMute.mock.calls) {
      stateFor(liveState, trackId).soloMute = [solo, mute];
    }
    for (const [trackId, delay] of liveEngine.setTrackStripChannelDelaySamples.mock.calls) {
      stateFor(liveState, trackId).delay = delay;
    }
    for (const [trackId, panLaw] of liveEngine.setTrackStripPanLaw.mock.calls) {
      stateFor(liveState, trackId).panLaw = panLaw;
    }
    for (const [trackId, panMode] of liveEngine.setTrackStripPanMode.mock.calls) {
      stateFor(liveState, trackId).panMode = panMode;
    }
    for (const [trackId, left, right] of liveEngine.setTrackStripDualPan.mock.calls) {
      stateFor(liveState, trackId).dualPan = [left, right];
    }
    for (const [, paramId, value] of offline.named('setParameter')) {
      const id = paramId as number;
      const laneIndex = (id >>> 8) & 0xff;
      const kind = id & 0xff;
      if (
        (id & 0xffff0000) !== ENGINE_MIXER_TARGET_BASE ||
        laneIndex === ENGINE_MIXER_LANE_MASTER
      ) {
        continue;
      }
      const state = stateFor(offlineState, offlineTrackId(laneIndex));
      if (kind === ENGINE_MIXER_PARAM_FADER_DB) state.gainDb = value;
      if (kind === 2) state.pan = value;
    }
    for (const [, laneIndex, solo, mute] of offline.named('setSoloMute')) {
      stateFor(offlineState, offlineTrackId(laneIndex as number)).soloMute = [solo, mute];
    }
    for (const [, trackId, delay] of offline.named('setTrackStripChannelDelaySamples')) {
      stateFor(offlineState, trackId as number).delay = delay;
    }
    for (const [, trackId, panLaw] of offline.named('setTrackStripPanLaw')) {
      stateFor(offlineState, trackId as number).panLaw = panLaw;
    }
    for (const [, trackId, panMode] of offline.named('setTrackStripPanMode')) {
      stateFor(offlineState, trackId as number).panMode = panMode;
    }
    for (const [, trackId, left, right] of offline.named('setTrackStripDualPan')) {
      stateFor(offlineState, trackId as number).dualPan = [left, right];
    }

    expect([...offlineState.entries()].sort()).toEqual([...liveState.entries()].sort());
  });

  it('folds a VCA group offset into the member lane fader', async () => {
    const doc = makeDoc();
    (doc.mixer as { vcaGroups?: unknown }).vcaGroups = [{ id: 'vca-1', name: 'Drums', gainDb: -6 }];
    (doc.tracks[1] as { vcaId?: string }).vcaId = 'vca-1';

    const engine = new FakeEngine();
    await renderProjectWithEngine(doc, renderOptions(engine));

    const params = new Map(engine.named('setParameter').map(([, id, value]) => [id, value]));
    // Drums: unity volume + 2 dB strip trim - 6 dB VCA offset.
    expect(params.get(drumsFader)).toBeCloseTo(linearToDb(1) + 2 - 6, 5);
  });

  it('folds only the VCA offset into absolute track fader automation', async () => {
    const doc = makeDoc();
    doc.tracks[1].volume = 0.5;
    (doc.mixer as { vcaGroups?: unknown }).vcaGroups = [{ id: 'vca-1', name: 'Drums', gainDb: -6 }];
    (doc.tracks[1] as { vcaId?: string }).vcaId = 'vca-1';
    doc.tracks[1].automation = [
      { param: 'faderDb', enabled: true, points: [{ ppq: 0, value: -12 }] },
    ];

    const engine = new FakeEngine();
    await renderProjectWithEngine(doc, renderOptions(engine));

    expect(engine.named('setAutomationLane')).toContainEqual([
      'setAutomationLane',
      drumsFader,
      [{ ppq: 0, value: -18, curveToNext: 0 }],
    ]);
  });

  it('keeps a solo-safe lane audible while another track is soloed', async () => {
    const doc = makeDoc();
    (doc.tracks[0] as { solo: boolean }).solo = true;
    (doc.tracks[1] as { soloSafe?: boolean }).soloSafe = true;

    const engine = new FakeEngine();
    await renderProjectWithEngine(doc, renderOptions(engine));

    // Mix pass: the soloed Keys lane and the solo-safe Drums lane both solo.
    expect(engine.named('setSoloMute')).toEqual([
      ['setSoloMute', 0, true, false],
      ['setSoloMute', 1, true, false],
    ]);
  });

  it('applies pan law, mode, dual-pan and channel delay; omits defaults', async () => {
    const doc = makeDoc();
    Object.assign((doc.tracks[1] as { mixer: Record<string, unknown> }).mixer, {
      panLaw: 'const6dB',
      panMode: 'dualPan',
      dualPan: { left: -1, right: 1 },
      channelDelaySamples: 128,
    });

    const engine = new FakeEngine();
    await renderProjectWithEngine(doc, renderOptions(engine));

    expect(engine.named('setTrackStripPanLaw')).toEqual([['setTrackStripPanLaw', 2, 'const6dB']]);
    expect(engine.named('setTrackStripPanMode')).toEqual([['setTrackStripPanMode', 2, 'dualPan']]);
    expect(engine.named('setTrackStripDualPan')).toEqual([['setTrackStripDualPan', 2, -1, 1]]);
    expect(engine.named('setTrackStripChannelDelaySamples')).toEqual([
      ['setTrackStripChannelDelaySamples', 2, 128],
    ]);
    // The Keys lane keeps engine defaults, so no calls reference track 1.
    for (const name of ['setTrackStripPanLaw', 'setTrackStripPanMode']) {
      expect(engine.named(name).some(([, trackId]) => trackId === 1)).toBe(false);
    }
  });

  it('adds automatic insert PDC to offline track channel delays', async () => {
    const doc = makeDoc();
    (doc.tracks[0] as { mixer: Record<string, unknown> }).mixer = {
      gainDb: 0,
      pan: 0,
      inserts: [{ processor: 'linear.eq', params: {}, enabled: true }],
      sends: [],
    };
    Object.assign((doc.tracks[1] as { mixer: Record<string, unknown> }).mixer, {
      channelDelaySamples: 8,
    });

    const engine = new FakeEngine();
    await renderProjectWithEngine(doc, {
      ...renderOptions(engine),
      insertLatency: (slot) => (slot.processor === 'linear.eq' ? 128 : 0),
    });

    expect(engine.named('setTrackStripChannelDelaySamples')).toEqual([
      ['setTrackStripChannelDelaySamples', 2, 136],
    ]);
  });

  it('declares a neutral strip before PDC on a lane without strip DSP', async () => {
    const doc = makeDoc();
    (doc.tracks[0] as { mixer: Record<string, unknown> }).mixer = {
      gainDb: 0,
      pan: 0,
      inserts: [{ processor: 'saturation.ampSim', params: {}, enabled: true }],
      sends: [],
    };
    doc.tracks[1].mixer = undefined;

    const engine = new FakeEngine();
    await renderProjectWithEngine(doc, {
      ...renderOptions(engine),
      insertLatency: (slot) => (slot.processor === 'saturation.ampSim' ? 12 : 0),
    });

    const neutralIndex = engine.calls.findIndex(
      ([name, trackId, json]) =>
        name === 'setTrackStripJson' &&
        trackId === 2 &&
        typeof json === 'string' &&
        JSON.parse(json).strips[0].inserts.length === 0,
    );
    const delayIndex = engine.calls.findIndex(
      ([name, trackId]) => name === 'setTrackStripChannelDelaySamples' && trackId === 2,
    );

    expect(neutralIndex).toBeGreaterThanOrEqual(0);
    expect(delayIndex).toBeGreaterThan(neutralIndex);
    expect(engine.named('setTrackStripChannelDelaySamples')).toContainEqual([
      'setTrackStripChannelDelaySamples',
      2,
      12,
    ]);
  });

  it('marks a pre-fader send in the lane descriptor', async () => {
    const doc = makeDoc();
    (doc.tracks[1] as { mixer: { sends: Array<Record<string, unknown>> } }).mixer.sends[0].timing =
      'preFader';

    const engine = new FakeEngine();
    await renderProjectWithEngine(doc, renderOptions(engine));

    expect(engine.named('setTrackLanes')[0][1]).toEqual([
      { trackId: 1 },
      { trackId: 2, sends: [{ busId: 1, levelDb: -9, enabled: true, sendTiming: 'preFader' }] },
    ]);
  });

  it('preserves disabled sends as disabled lane descriptors', async () => {
    const doc = makeDoc();
    (doc.tracks[1] as { mixer: { sends: Array<Record<string, unknown>> } }).mixer.sends[0].enabled =
      false;

    const engine = new FakeEngine();
    await renderProjectWithEngine(doc, renderOptions(engine));

    expect(engine.named('setTrackLanes')[0][1]).toEqual([
      { trackId: 1 },
      { trackId: 2, sends: [{ busId: 1, levelDb: -9, enabled: false }] },
    ]);
  });

  it('replays user bus insert chains before rendering', async () => {
    const doc = makeDoc();
    (doc.mixer?.buses[0] as unknown as { strip: Record<string, unknown> }).strip = {
      gainDb: 0,
      pan: 0,
      sends: [],
      inserts: [
        { processor: 'dynamics.compressor', params: { thresholdDb: -20 }, enabled: true },
        { processor: 'saturation.tape', params: { drive: 0.4 }, enabled: false },
      ],
    };

    const engine = new FakeEngine();
    await renderProjectWithEngine(doc, renderOptions(engine));

    expect(engine.named('setBusStripJson')).toHaveLength(1);
    expect(JSON.parse(engine.named('setBusStripJson')[0][2] as string)).toEqual({
      version: 1,
      strips: [],
      buses: [
        {
          id: 'bus-1',
          role: 'submix',
          inserts: [
            { slot: 'pre', processor: 'dynamics.compressor', params: { thresholdDb: -20 } },
          ],
        },
      ],
      connections: [],
    });
  });

  it('does not treat legacy bus EQ state as exportable bus scene DSP', async () => {
    const doc = makeDoc();
    (doc.mixer?.buses[0] as unknown as { strip: Record<string, unknown> }).strip = {
      gainDb: 0,
      pan: 0,
      sends: [],
      inserts: [],
      eq: {
        enabled: true,
        bands: [{ enabled: true, type: 'peak', frequencyHz: 1200, gainDb: 4, q: 1 }],
      },
    };

    const engine = new FakeEngine();
    await renderProjectWithEngine(doc, renderOptions(engine));

    expect(engine.named('setBusStripJson')).toEqual([]);
  });

  it('exports bus EQ when the future bus EQ offline ABI exists', async () => {
    const doc = makeDoc();
    const band = { enabled: true, type: 'peak', frequencyHz: 1200, gainDb: 4, q: 1 };
    if (doc.mixer) {
      doc.mixer.buses[0].strip = {
        gainDb: 0,
        pan: 0,
        sends: [],
        inserts: [],
        eq: {
          enabled: true,
          bands: [band],
        },
      };
    }

    const engine = new FakeEngineWithBusEq();
    await renderProjectWithEngine(doc, renderOptions(engine));

    const scene = JSON.parse(engine.named('setBusStripJson')[0][2] as string);
    expect(scene.buses[0].eq).toEqual({ enabled: true, bands: [band] });
    expect(engine.named('setBusStripEqBandJson')).toEqual([
      ['setBusStripEqBandJson', 1, 0, JSON.stringify(band)],
    ]);
  });

  it('exports return-bus pan and EQ fields with neutral defaults omitted', async () => {
    const doc = makeDoc();
    const band = { enabled: true, type: 'peak', frequencyHz: 1200, gainDb: 4, q: 1 };
    if (doc.mixer) {
      doc.mixer.buses[0].strip = {
        gainDb: 0,
        pan: 0.25,
        panLaw: 'linear0dB',
        panMode: 'dualPan',
        dualPan: { left: -0.5, right: 0.75 },
        sends: [],
        inserts: [],
        eq: { enabled: true, bands: [band] },
      };
    }

    const engine = new FakeEngineWithBusEq();
    await renderProjectWithEngine(doc, renderOptions(engine));

    const scene = JSON.parse(engine.named('setBusStripJson')[0][2] as string);
    expect(scene.buses[0]).toMatchObject({
      pan: 0.25,
      panLaw: 3,
      panMode: 2,
      dualPanLeft: -0.5,
      dualPanRight: 0.75,
      eq: { enabled: true, bands: [band] },
    });
    expect(scene.buses[0]).not.toHaveProperty('inputTrimDb');
    expect(scene.buses[0]).not.toHaveProperty('width');
  });

  it('replays bus gain automation lanes before rendering', async () => {
    const doc = makeDoc();
    if (doc.mixer) {
      doc.mixer.buses[0].automation = [
        {
          param: 'faderDb',
          enabled: true,
          points: [
            { ppq: 0, value: -12 },
            { ppq: 960, value: -3, curve: 'hold' },
          ],
        },
      ];
    }

    const engine = new FakeEngine();
    await renderProjectWithEngine(doc, renderOptions(engine));

    expect(engine.named('setAutomationLane')).toContainEqual([
      'setAutomationLane',
      BUS_1_FADER_PARAM_ID,
      [
        { ppq: 0, value: -12, curveToNext: 0 },
        { ppq: 960, value: -3, curveToNext: 2 },
      ],
    ]);
  });

  it('keeps a muted return silent when its fader has automation', async () => {
    const doc = makeDoc();
    if (doc.mixer) {
      doc.mixer.buses[0].mute = true;
      doc.mixer.buses[0].automation = [
        { param: 'faderDb', enabled: true, points: [{ ppq: 0, value: 12 }] },
      ];
    }
    const engine = new FakeEngine();

    await renderProjectWithEngine(doc, renderOptions(engine));

    expect(engine.named('setTrackBuses')[0][1]).toEqual([{ busId: 1, gainDb: -120 }]);
    expect(engine.named('setAutomationLane')).not.toContainEqual([
      'setAutomationLane',
      BUS_1_FADER_PARAM_ID,
      expect.anything(),
    ]);
  });

  it('maps bus insert automation through enabled-only insert indexes in export', async () => {
    const doc = makeDoc();
    if (doc.mixer) {
      doc.mixer.buses[0].strip = {
        inserts: [
          { processor: 'saturation.tape', params: {}, enabled: false },
          { processor: 'dynamics.compressor', params: { thresholdDb: -20 }, enabled: true },
        ],
        sends: [],
      };
      doc.mixer.buses[0].automation = [
        {
          param: 'insert:1:thresholdDb',
          enabled: true,
          points: [{ ppq: 0, value: -24 }],
        },
        {
          param: 'insert:0:drive',
          enabled: true,
          points: [{ ppq: 0, value: 0.5 }],
        },
      ];
    }

    const engine = new FakeEngine();
    await renderProjectWithEngine(doc, renderOptions(engine));

    expect(engine.named('resolveBusInsertAutomationId')).toEqual([
      ['resolveBusInsertAutomationId', 1, 0, 'thresholdDb'],
    ]);
  });

  it('keeps store indexes for bus automation when the bypass ABI declares every slot', async () => {
    const doc = makeDoc();
    if (doc.mixer) {
      doc.mixer.buses[0].strip = {
        inserts: [
          { processor: 'saturation.tape', params: {}, enabled: false },
          { processor: 'dynamics.compressor', params: { thresholdDb: -20 }, enabled: true },
        ],
        sends: [],
      };
      doc.mixer.buses[0].automation = [
        {
          param: 'insert:1:thresholdDb',
          enabled: true,
          points: [{ ppq: 0, value: -24 }],
        },
      ];
    }

    const engine = new BusBypassFakeEngine();
    await renderProjectWithEngine(doc, renderOptions(engine));

    expect(engine.named('setBusStripInsertBypassed')).toContainEqual([
      'setBusStripInsertBypassed',
      1,
      0,
      true,
    ]);
    expect(engine.named('resolveBusInsertAutomationId')).toEqual([
      ['resolveBusInsertAutomationId', 1, 1, 'thresholdDb'],
    ]);
  });

  it('filters non-finite automation points before installing lanes', async () => {
    const doc = makeDoc();
    doc.tracks[0].automation = [
      {
        param: 'faderDb',
        enabled: true,
        points: [
          { ppq: 0, value: -12 },
          { ppq: Number.NaN, value: -6 },
          { ppq: 4, value: Number.NaN },
        ],
      },
    ];
    doc.masterAutomation = [{ param: 'faderDb', enabled: true, points: [{ ppq: 0, value: NaN }] }];
    if (doc.mixer) {
      doc.mixer.buses[0].automation = [
        {
          param: 'faderDb',
          enabled: true,
          points: [
            { ppq: 0, value: -9 },
            { ppq: Number.POSITIVE_INFINITY, value: -3 },
          ],
        },
      ];
    }

    const engine = new FakeEngine();
    await renderProjectWithEngine(doc, renderOptions(engine));

    expect(engine.named('setAutomationLane')).toContainEqual([
      'setAutomationLane',
      0x4d580001,
      [{ ppq: 0, value: -12, curveToNext: 0 }],
    ]);
    expect(engine.named('setAutomationLane')).toContainEqual([
      'setAutomationLane',
      BUS_1_FADER_PARAM_ID,
      [{ ppq: 0, value: -9, curveToNext: 0 }],
    ]);
    expect(engine.named('setAutomationLane').some(([, id]) => id === MASTER_FADER_PARAM_ID)).toBe(
      false,
    );
  });
});

/**
 * Audible fake that also serves clips from page providers, so a streamed
 * render can be compared sample for sample against a decoded one.
 */
class PagingAudibilityEngine extends AudibilityEngine {
  readonly providers: Array<{
    id: number;
    numChannels: number;
    numSamples: number;
    pageFrames: number;
    pages: Map<number, Float32Array[]>;
    destroyed: boolean;
  }> = [];
  /** Highest page count any single provider held at once. */
  peakResidentPages = 0;

  createClipPageProvider(numChannels: number, numSamples: number, pageFrames: number) {
    const entry = {
      id: this.providers.length + 1,
      numChannels,
      numSamples,
      pageFrames,
      pages: new Map<number, Float32Array[]>(),
      destroyed: false,
    };
    this.providers.push(entry);
    const track = () => {
      this.peakResidentPages = Math.max(this.peakResidentPages, entry.pages.size);
    };
    return {
      id: entry.id,
      supply: (pageIndex: number, channels: Float32Array[]) => {
        entry.pages.set(pageIndex, channels);
        track();
      },
      clear: (pageIndex: number) => {
        entry.pages.delete(pageIndex);
      },
      destroy: () => {
        entry.destroyed = true;
        entry.pages.clear();
      },
    };
  }

  protected clipSample(
    clip: { channels: Float32Array[]; pageProvider?: unknown },
    channelIndex: number,
    clipFrame: number,
    fallback: number,
  ): number {
    const providerId = (clip.pageProvider as { id?: number } | undefined)?.id;
    if (providerId === undefined) {
      return super.clipSample(
        clip as Parameters<AudibilityEngine['clipSample']>[0],
        channelIndex,
        clipFrame,
        fallback,
      );
    }
    const entry = this.providers.find((candidate) => candidate.id === providerId);
    if (!entry) return 0;
    const page = entry.pages.get(Math.floor(clipFrame / entry.pageFrames));
    // A page the render failed to keep resident reads as silence, which is
    // exactly the corruption the streamed path must never produce.
    if (!page) return 0;
    const channels = page[channelIndex] ?? page[0];
    return channels?.[clipFrame % entry.pageFrames] ?? 0;
  }
}

describe('renderProjectWithEngine paged audio clips', () => {
  // Past the streaming length floor, so the planner has something to page.
  const SOURCE_FRAMES = 48000 * 20;
  const RATE = 48000;

  /** Deterministic per-frame ramp so a misplaced page is audible. */
  function sourceChannels(): Float32Array[] {
    const left = new Float32Array(SOURCE_FRAMES);
    const right = new Float32Array(SOURCE_FRAMES);
    for (let i = 0; i < SOURCE_FRAMES; i += 1) {
      left[i] = ((i % 1000) / 1000) * 0.5;
      right[i] = 0.5 - left[i];
    }
    return [left, right];
  }

  const assetMeta = {
    id: 'long-1',
    name: 'long.wav',
    sampleRate: RATE,
    numChannels: 2,
    numFrames: SOURCE_FRAMES,
  };

  function pagedDoc(): ProjectDocument {
    return {
      schemaVersion: 3,
      name: 'paged',
      sampleRate: RATE,
      tempoSegments: [{ startPpq: 0, bpm: 120 }],
      timeSignatures: [],
      markers: [],
      sections: [],
      tracks: [
        {
          name: 'Audio',
          color: '#fff',
          kind: 'audio',
          mute: false,
          solo: false,
          volume: 1,
          pan: 0,
          clips: [
            {
              name: 'long take',
              kind: 'audio',
              assetId: 'long-1',
              startPpq: 2,
              // 20 quarter notes = 10 s, from 0.5 s into the source.
              lengthPpq: 20,
              sourceOffsetPpq: 1,
              gain: 0.75,
              loopEnabled: false,
              loopLengthPpq: 0,
              notes: [],
            },
          ],
        },
      ],
    } as unknown as ProjectDocument;
  }

  function options(engine: FakeEngine, extra: Record<string, unknown> = {}) {
    const channels = sourceChannels();
    return {
      deps: null,
      createEngine: () => engine,
      loadAudioAsset: async () => ({ meta: assetMeta, channels }),
      loadAudioAssetMeta: async () => assetMeta,
      ...extra,
    };
  }

  /** Page provider factory reading straight out of the source buffers. */
  function pageStream() {
    const channels = sourceChannels();
    const reads: Array<{ startFrame: number; frameCount: number }> = [];
    const factory = createAssetClipPageBindingFactory(async (_assetId, startFrame, frameCount) => {
      reads.push({ startFrame, frameCount });
      return channels.map((channel) => channel.slice(startFrame, startFrame + frameCount));
    });
    return { factory, reads };
  }

  it('renders a paged clip sample for sample like a decoded one', async () => {
    const decodedEngine = new PagingAudibilityEngine();
    const decoded = await renderProjectWithEngine(pagedDoc(), options(decodedEngine));

    const stream = pageStream();
    const pagedEngine = new PagingAudibilityEngine();
    const loadAudioAsset = vi.fn(async () => ({ meta: assetMeta, channels: sourceChannels() }));
    const paged = await renderProjectWithEngine(
      pagedDoc(),
      options(pagedEngine, {
        loadAudioAsset,
        createClipPageStream: stream.factory,
        // Small enough that the clip spans several pages.
        clipStreamResidentBudgetBytes: 3 * 256 * 1024,
      }),
    );

    expect(paged.totalFrames).toBe(decoded.totalFrames);
    expect(Array.from(paged.channels[0])).toEqual(Array.from(decoded.channels[0]));
    expect(Array.from(paged.channels[1])).toEqual(Array.from(decoded.channels[1]));
    // Nothing decoded the asset, and the resident window stayed bounded.
    expect(loadAudioAsset).not.toHaveBeenCalled();
    expect(pagedEngine.peakResidentPages).toBeLessThanOrEqual(3);
    expect(stream.reads.length).toBeGreaterThan(3);
    // Reads start at the clip's own window, not the head of the asset.
    expect(stream.reads[0].startFrame).toBe(24000);
    expect(pagedEngine.providers.every((provider) => provider.destroyed)).toBe(true);
  });

  it('is not louder or quieter than the decoded path', async () => {
    const decodedEngine = new PagingAudibilityEngine();
    const decoded = await renderProjectWithEngine(pagedDoc(), options(decodedEngine));
    const stream = pageStream();
    const paged = await renderProjectWithEngine(
      pagedDoc(),
      options(new PagingAudibilityEngine(), { createClipPageStream: stream.factory }),
    );
    const peak = (channel: Float32Array): number =>
      channel.reduce((max, value) => Math.max(max, Math.abs(value)), 0);
    expect(peak(paged.channels[0])).toBeGreaterThan(0);
    expect(peak(paged.channels[0])).toBe(peak(decoded.channels[0]));
  });

  it('fails the render instead of writing silence when a page cannot be read', async () => {
    const factory = createAssetClipPageBindingFactory(async (_assetId, startFrame) => {
      throw new Error(`unreadable page at ${startFrame}`);
    });
    await expect(
      renderProjectWithEngine(
        pagedDoc(),
        options(new PagingAudibilityEngine(), { createClipPageStream: factory }),
      ),
    ).rejects.toThrow('unreadable page');
  });

  it('decodes as before when no page stream is supplied', async () => {
    const engine = new PagingAudibilityEngine();
    const loadAudioAsset = vi.fn(async () => ({ meta: assetMeta, channels: sourceChannels() }));
    await renderProjectWithEngine(pagedDoc(), options(engine, { loadAudioAsset }));
    expect(loadAudioAsset).toHaveBeenCalled();
    expect(engine.providers).toEqual([]);
  });
});

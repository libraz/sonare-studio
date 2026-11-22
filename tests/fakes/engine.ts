/**
 * Shared typed fakes of core engine values. Fakes are shaped from the core
 * types so a spec cannot feed production code a shape the core no longer makes.
 */

import type {
  MasteringInsertParamInfo,
  MidiFxConfig,
  RealtimeEngine,
  SoloProcessor,
} from '@libraz/libsonare';
import type { SonareEngine } from '@libraz/libsonare/worklet';
import type { EngineHandle } from '@/engine/engine';
import type { MeterSource, StereoMeterLevels } from '@/engine/meters';
import type { OfflineRenderEngine } from '@/export/engine-render-types';

export const ENGINE_MIXER_TARGET_BASE = 0x4d580000;
export const ENGINE_MIXER_PARAM_FADER_DB = 1;
export const ENGINE_MIXER_PARAM_PAN = 2;
export const ENGINE_MIXER_LANE_MASTER = 0xff;

/** Records every engine call and renders a constant sample value. */
export class FakeRenderEngine implements OfflineRenderEngine {
  calls: Array<[string, ...unknown[]]> = [];
  destroyed = false;
  /** Sample value process() writes into every frame. */
  fill = 0.25;
  /** Value tailSamples reports. */
  tail = 0;

  private record(name: string, ...args: unknown[]): void {
    this.calls.push([name, ...args]);
  }
  named(name: string): Array<[string, ...unknown[]]> {
    return this.calls.filter(([n]) => n === name);
  }

  private declaredTrackIds: number[] = [];
  private declaredBusIds = new Set<number>();

  setTrackLanes(lanes: Parameters<RealtimeEngine['setTrackLanes']>[0]): void {
    this.record('setTrackLanes', lanes);
    this.declaredTrackIds = lanes.map((lane) => lane.trackId);
  }
  setTrackBuses(buses: Parameters<RealtimeEngine['setTrackBuses']>[0]): void {
    this.record('setTrackBuses', buses);
    this.declaredBusIds = new Set(buses.map((bus) => bus.busId));
  }
  /** Stub ids keep the packed lane-position shape so tests can decode them. */
  resolveStripAutomationId(ref: number | 'master', paramName: 'faderDb' | 'pan' | 'width'): number {
    if (ref === 'master') {
      if (paramName === 'width') return -1;
      const kind = paramName === 'pan' ? ENGINE_MIXER_PARAM_PAN : ENGINE_MIXER_PARAM_FADER_DB;
      return ENGINE_MIXER_TARGET_BASE | (ENGINE_MIXER_LANE_MASTER << 8) | kind;
    }
    const laneIndex = this.declaredTrackIds.indexOf(ref);
    if (laneIndex < 0) return -1;
    const kind = paramName === 'pan' ? ENGINE_MIXER_PARAM_PAN : ENGINE_MIXER_PARAM_FADER_DB;
    return ENGINE_MIXER_TARGET_BASE | (laneIndex << 8) | kind;
  }
  resolveBusAutomationId(busId: number, _paramName: 'faderDb'): number {
    if (!this.declaredBusIds.has(busId)) return -1;
    return ENGINE_MIXER_TARGET_BASE | ((254 - busId) << 8) | ENGINE_MIXER_PARAM_FADER_DB;
  }
  setStrip(...[ref, settings]: Parameters<RealtimeEngine['setStrip']>): void {
    this.record('setStrip', ref, settings);
  }
  setBusStrip(...[busId, settings]: Parameters<RealtimeEngine['setBusStrip']>): void {
    this.record('setBusStrip', busId, settings);
  }
  setStripSidechain(ref: number | 'master', insertIndex: number, source: unknown): void {
    this.record('setStripSidechain', ref, insertIndex, source);
  }
  setBusSidechain(busId: number, insertIndex: number, source: unknown): void {
    this.record('setBusSidechain', busId, insertIndex, source);
  }
  setStripInsertBypassed(
    ref: number | 'master',
    index: number,
    state: { bypassed: boolean; resetOnBypass?: boolean },
  ): void {
    this.record('setStripInsertBypassed', ref, index, state);
  }
  setBusInsertBypassed(
    busId: number,
    index: number,
    state: { bypassed: boolean; resetOnBypass?: boolean },
  ): void {
    this.record('setBusInsertBypassed', busId, index, state);
  }
  setStripEqBand(ref: number | 'master', bandIndex: number, band: unknown): void {
    this.record('setStripEqBand', ref, bandIndex, band);
  }
  setBusEqBand(busId: number, bandIndex: number, band: unknown): void {
    this.record('setBusEqBand', busId, bandIndex, band);
  }
  setTrackSoloMute(trackId: number, state: { solo: boolean; mute: boolean }): void {
    this.record('setTrackSoloMute', trackId, state);
  }
  setStripPanLaw(ref: number | 'master', panLaw: unknown): void {
    this.record('setStripPanLaw', ref, panLaw);
  }
  setStripPanMode(ref: number | 'master', panMode: unknown): void {
    this.record('setStripPanMode', ref, panMode);
  }
  setStripDualPan(ref: number | 'master', leftPan: number, rightPan: number): void {
    this.record('setStripDualPan', ref, leftPan, rightPan);
  }
  setStripChannelDelaySamples(ref: number | 'master', delaySamples: number): void {
    this.record('setStripChannelDelaySamples', ref, delaySamples);
  }
  setParameter(paramId: number, value: number): void {
    this.record('setParameter', paramId, value);
  }
  setAutomationLane(paramId: number, points: unknown): void {
    this.record('setAutomationLane', paramId, points);
  }
  resolveStripInsertAutomationId(
    ref: number | 'master',
    insertIndex: number,
    paramName: string,
  ): number {
    this.record('resolveStripInsertAutomationId', ref, insertIndex, paramName);
    if (paramName === 'unknown') return -1;
    if (ref === 'master') return (0xe1ff0000 | (insertIndex << 8)) >>> 0;
    return (0xe0000000 | (ref << 16) | (insertIndex << 8)) >>> 0;
  }
  resolveBusInsertAutomationId(busId: number, insertIndex: number, paramName: string): number {
    this.record('resolveBusInsertAutomationId', busId, insertIndex, paramName);
    return paramName === 'unknown' ? -1 : (0xe1fe0000 | (busId << 8) | insertIndex) >>> 0;
  }
  resolveInstrumentAutomationId(destinationId: number, paramName: string): number {
    this.record('resolveInstrumentAutomationId', destinationId, paramName);
    return paramName === 'unknown' ? -1 : (0xc0000000 | (destinationId << 8)) >>> 0;
  }
  setMidiFx(destinationId: number, config: MidiFxConfig): void {
    this.record('setMidiFx', destinationId, config);
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
  get warpStretchOverflowCount(): number {
    return 0;
  }
  get tailSamples(): number {
    return this.tail;
  }
  setMidiClips(clips: unknown): void {
    this.record('setMidiClips', clips);
  }
  setSynthInstrument(destinationId?: number | null, patch?: object): void {
    this.record('setSynthInstrument', patch, destinationId);
  }
  loadSoundFont(data: Uint8Array): void {
    this.record('loadSoundFont', data);
  }
  setSf2Instrument(destinationId?: number | null, config?: object): void {
    this.record('setSf2Instrument', config, destinationId);
  }
  pushMidiSysex(destinationId: number, data: Uint8Array, renderFrame = -1): void {
    this.record('pushMidiSysex', destinationId, data, renderFrame);
  }
  pushMidiUmp(destinationId: number, words: Uint32Array | number[]): void {
    this.record('pushMidiUmp', destinationId, words);
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

/** Builds a silent-by-default meter source whose levels can be overridden. */
export function fakeMeterSource(levels: Partial<StereoMeterLevels> = {}): MeterSource {
  return {
    latest: {
      frame: 0,
      peakDbL: -12,
      peakDbR: -12,
      rmsDbL: -18,
      rmsDbR: -18,
      correlation: 0,
      ...levels,
    },
    subscribe: () => () => {},
    subscribeInsertGainReduction: () => () => {},
  };
}

/**
 * An AudioContext with only the given members; jsdom has no Web Audio, so a
 * member that is not provided is absent.
 */
export function fakeAudioContext(parts: Partial<AudioContext> = {}): AudioContext {
  const ctx = parts;
  assertWhole<AudioContext>(ctx);
  return ctx;
}

/**
 * Declares a partial fake to be the whole type without copying it, so a spec
 * that keeps a reference to the fake still sees later edits made through it.
 */
function assertWhole<T>(_value: unknown): asserts _value is T {}

/** One level of members optional at every depth, so a fake supplies only what a spec drives. */
export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends (...args: never[]) => unknown
    ? T[K] | ((...args: never[]) => unknown)
    : T[K] extends object
      ? DeepPartial<T[K]>
      : T[K];
};

/**
 * Builds an EngineHandle whose engine implements only the members given.
 * SonareEngine is a class with private state, so the partial engine cannot be
 * a structural literal: a member that is not provided is absent, and calling
 * it throws.
 */
export function fakeEngineHandle(
  parts: {
    engine?: DeepPartial<SonareEngine>;
    ctx?: Partial<AudioContext>;
    capabilities?: Partial<EngineHandle['capabilities']>;
    dispose?: EngineHandle['dispose'];
  } = {},
): EngineHandle {
  const engine = parts.engine ?? {};
  assertWhole<SonareEngine>(engine);
  const ctx = fakeAudioContext(parts.ctx);
  return {
    engine,
    ctx,
    capabilities: {
      mode: 'postMessage',
      runtimeTarget: 'embind',
      sharedArrayBuffer: false,
      atomics: false,
      audioWorklet: true,
      clipPageRequestsRealtimeSafe: false,
      externalMidiRealtimeSafe: false,
      cueOutput: false,
      ...parts.capabilities,
    },
    dispose: parts.dispose ?? (async () => {}),
  };
}

/** A processor id outside the core catalog, for specs that assert an unknown insert is refused or tolerated. */
export function unsupportedProcessor(name: string): SoloProcessor {
  return name as SoloProcessor;
}

/** A complete number-parameter descriptor as the core catalog reports it; absent min/max means unbounded. */
export function fakeParamInfo(
  info: Pick<MasteringInsertParamInfo, 'name'> & Partial<MasteringInsertParamInfo>,
): MasteringInsertParamInfo {
  return {
    type: 'number',
    rtSafe: true,
    minExclusive: false,
    maxExclusive: false,
    scale: 'linear',
    dependsOn: [],
    coupledWith: [],
    ...info,
  };
}

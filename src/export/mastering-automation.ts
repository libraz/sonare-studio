/**
 * Plans how the offline export runs the mastering rack when its parameters
 * are automated.
 *
 * The rack is authoritative as a post-bounce, whole-buffer chain applied in
 * declared order, and `masteringApplyProcessorStereo` takes one parameter value for
 * the whole call. A time-varying lane therefore has nowhere to go on that
 * path, and the render used to freeze it at the value under the render start.
 *
 * The engine can drive the very same processors as strip inserts with
 * block-accurate automation. That is what live playback already previews with,
 * and offline renders of the same processor through both entry points agree to
 * the float32 noise floor once the processor's reported latency is removed, so
 * a stage can move between them without changing what it does to the signal.
 *
 * The plan keeps every stage the user did not automate on the existing
 * whole-buffer call, in declared order, so a project without mastering
 * automation renders exactly as before. Only automated stages are routed
 * through an engine pass, and only when both the processor and the parameter
 * can actually be driven there.
 */

import { resolveAutomationId } from '@/engine/automation-ids';
import { engineAutomationPoints } from '@/engine/engine-declaration';
import { stripScene } from '@/engine/strip-sync';
import {
  type AutomationParam,
  type AutomationPoint,
  evaluateAutomationValue,
  parseMasteringAutomationParam,
  sanitizeAutomationPoints,
} from '@/project/automation';
import { masteringIndexForAutomationRef } from '@/project/automation-insert';
import type {
  InsertParamValue,
  InsertSlot,
  MasteringChainState,
  MixerStrip,
} from '@/project/mixer';
import {
  BLOCKS_PER_CHECKPOINT,
  type OfflineRenderEngine,
  RENDER_BLOCK_FRAMES,
  silentBlockInputs,
} from './engine-render-types';

/** What the engine catalog says one mastering processor can do. */
export interface MasteringProcessorCapability {
  /** True when the processor can run as an engine strip insert. */
  realtimeInsertable: boolean;
  /** Reported processing latency in samples. */
  latencySamples: number;
  /**
   * Parameters the engine moves at audio rate. The engine hands out an
   * automation id for every parameter name it knows, including ones it will
   * then ignore, so this set is the only thing that separates a lane that
   * plays from a lane that silently does nothing.
   */
  automatableParams: ReadonlySet<string>;
}

/** Resolves capability metadata for one processor id; undefined = unknown. */
export type MasteringCapabilityLookup = (
  processor: string,
) => MasteringProcessorCapability | undefined;

/** Catalog entry shape this module reads (a subset of the wasm catalog). */
export interface MasteringCatalogEntry {
  id: string;
  realtimeInsertable?: boolean;
  latencySamples?: number;
  params?: ReadonlyArray<{ name: string; rtSafe?: boolean }>;
}

/**
 * Builds a capability lookup from the engine's processor catalog.
 *
 * @param entries Catalog entries, or null/undefined when the build has none.
 * @returns A lookup returning undefined for unknown processors.
 */
export function masteringCapabilityFromCatalog(
  entries: ReadonlyArray<MasteringCatalogEntry> | null | undefined,
): MasteringCapabilityLookup {
  const byId = new Map<string, MasteringProcessorCapability>();
  for (const entry of entries ?? []) {
    const latency = entry.latencySamples;
    byId.set(entry.id, {
      realtimeInsertable: entry.realtimeInsertable === true,
      latencySamples: typeof latency === 'number' && latency > 0 ? Math.round(latency) : 0,
      automatableParams: new Set(
        (entry.params ?? []).filter((param) => param.rtSafe === true).map((param) => param.name),
      ),
    });
  }
  return (processor) => byId.get(processor);
}

/** The automation-lane fields this module reads. */
export interface MasteringAutomationLane {
  /** Automated parameter token. */
  param: AutomationParam;
  /** Breakpoints, before sanitization. */
  points: ReadonlyArray<AutomationPoint>;
  /** Whether the lane is applied. */
  enabled: boolean;
}

/** One parameter an engine pass drives over the render window. */
export interface MasteringAutomationBinding {
  /** Processor parameter name as the engine knows it. */
  paramName: string;
  /** Sanitized breakpoints in absolute PPQ. */
  points: ReadonlyArray<AutomationPoint>;
}

/** One processor inside an engine mastering pass. */
export interface MasteringEngineSlot {
  /** Index in the chain's processor list (for reporting). */
  processorIndex: number;
  /** Processor id. */
  processor: InsertSlot['processor'];
  /** Static parameter values, including frozen values for un-drivable lanes. */
  params: Record<string, InsertParamValue>;
  /** Parameters the engine drives; never empty. */
  bindings: MasteringAutomationBinding[];
}

/** One step of the offline mastering rack, in declared order. */
export type MasteringStage =
  | {
      /** Applied by the existing whole-buffer mastering call. */
      kind: 'whole-buffer';
      processorIndex: number;
      processor: InsertSlot['processor'];
      params: Record<string, InsertParamValue>;
    }
  | {
      /** Applied by one offline engine pass whose strip holds these slots. */
      kind: 'engine';
      slots: MasteringEngineSlot[];
      /** Samples the pass output lags its input by (the slots' latency sum). */
      latencySamples: number;
    };

/** The planned rack plus what the render still could not make time-varying. */
export interface MasteringStagePlan {
  /** Stages in declared order; applying them in sequence renders the rack. */
  stages: MasteringStage[];
  /**
   * Automated parameters the render still freezes at the window's start value,
   * as "<processor>.<paramName>". Empty when every lane is driven.
   */
  frozenParams: string[];
}

/**
 * True when a lane's breakpoints actually change value over time.
 *
 * A repeated breakpoint with the same value is observationally constant; its
 * PPQ alone must not produce a misleading "frozen automation" warning.
 * Conversely, same-PPQ values can differ in valid stored lanes, so compare the
 * value independently of position.
 *
 * @param points Sanitized breakpoints.
 * @returns True when at least two breakpoints differ in value.
 */
export function hasTimeVaryingPoints(points: ReadonlyArray<AutomationPoint>): boolean {
  if (points.length < 2) return false;
  const first = points[0];
  return points.some((point) => point.value !== first.value);
}

/** Sanitized mastering lanes grouped by processor index and parameter name. */
function automatedParamsByProcessor(
  chain: MasteringChainState,
  lanes: ReadonlyArray<MasteringAutomationLane>,
): Map<number, Map<string, AutomationPoint[]>> {
  const byProcessor = new Map<number, Map<string, AutomationPoint[]>>();
  for (const lane of lanes) {
    if (!lane.enabled || lane.points.length === 0) continue;
    const ref = parseMasteringAutomationParam(lane.param);
    if (!ref) continue;
    const processorIndex = masteringIndexForAutomationRef(chain, ref);
    if (processorIndex === undefined) continue;
    const points = sanitizeAutomationPoints(lane.param, lane.points);
    if (points.length === 0) continue;
    const params = byProcessor.get(processorIndex) ?? new Map<string, AutomationPoint[]>();
    params.set(ref.paramName, points);
    byProcessor.set(processorIndex, params);
  }
  return byProcessor;
}

/**
 * Plans the offline mastering rack for one render window.
 *
 * @param chain The project mastering chain, or undefined for no rack.
 * @param lanes Master automation lanes (mastering lanes are picked out here).
 * @param renderStartPpq PPQ the render window starts at; frozen values are
 *   sampled there, matching what a static render has always used.
 * @param capability Engine capability lookup; without it nothing is engine-driven.
 * @returns The ordered stages and the parameters that stayed frozen.
 */
export function planMasteringStages(
  chain: MasteringChainState | undefined,
  lanes: ReadonlyArray<MasteringAutomationLane>,
  renderStartPpq: number,
  capability: MasteringCapabilityLookup,
): MasteringStagePlan {
  const stages: MasteringStage[] = [];
  const frozenParams: string[] = [];
  if (!chain) return { stages, frozenParams };

  const automated = automatedParamsByProcessor(chain, lanes);
  for (let processorIndex = 0; processorIndex < chain.processors.length; processorIndex += 1) {
    const slot = chain.processors[processorIndex];
    if (!slot.enabled) continue;
    const params: Record<string, InsertParamValue> = { ...slot.params };
    const bindings: MasteringAutomationBinding[] = [];
    const support = capability(slot.processor);
    const insertable = support?.realtimeInsertable === true;

    for (const [paramName, points] of automated.get(processorIndex) ?? []) {
      const timeVarying = hasTimeVaryingPoints(points);
      if (timeVarying && insertable && support?.automatableParams.has(paramName) === true) {
        bindings.push({ paramName, points });
        continue;
      }
      // Not drivable here: keep the long-standing behaviour of rendering with
      // the value under the window start, and say so in the report.
      params[paramName] = evaluateAutomationValue(points, renderStartPpq);
      if (timeVarying) frozenParams.push(`${slot.processor}.${paramName}`);
    }

    if (bindings.length === 0) {
      stages.push({ kind: 'whole-buffer', processorIndex, processor: slot.processor, params });
      continue;
    }
    const engineSlot: MasteringEngineSlot = {
      processorIndex,
      processor: slot.processor,
      params,
      bindings,
    };
    const previous = stages[stages.length - 1];
    // Consecutive automated processors share one pass: a strip applies its
    // inserts in order, so merging preserves the declared rack order and the
    // reported latency is the sum (measured against the catalog).
    if (previous?.kind === 'engine') {
      previous.slots.push(engineSlot);
      previous.latencySamples += support?.latencySamples ?? 0;
      continue;
    }
    stages.push({
      kind: 'engine',
      slots: [engineSlot],
      latencySamples: support?.latencySamples ?? 0,
    });
  }
  return { stages, frozenParams };
}

/**
 * Engine lane the mastering pass renders on. The pass graph holds exactly one
 * lane carrying the already-bounced stereo mix, so the id only has to be
 * stable within that graph.
 */
const MASTERING_PASS_TRACK_ID = 1;

/** Everything an engine mastering pass needs besides the audio and the stage. */
export interface MasteringEnginePassContext {
  /** Engine factory (same seam the render uses, so tests can inject a fake). */
  createEngine: (sampleRate: number, blockSize: number) => OfflineRenderEngine;
  /** Render sample rate in Hz. */
  sampleRate: number;
  /** Timeline sample the mix buffer's first frame sits at. */
  startSample: number;
  /** Timeline PPQ the mix buffer's first frame sits at. */
  startPpq: number;
  /** Tempo map, so lane PPQ resolves to the same positions as the main render. */
  tempoSegments: ReadonlyArray<{ startPpq: number; bpm: number; endBpm?: number }>;
  /** Throws to abort the pass between blocks. */
  checkCancel?: () => void;
  /** Awaited every checkpoint of blocks so a worker can observe cancel messages. */
  yieldBetweenBlocks?: () => Promise<void>;
}

/** Strip carrying an engine mastering pass's processors, in declared order. */
function passStrip(slots: ReadonlyArray<MasteringEngineSlot>): MixerStrip {
  return {
    gainDb: 0,
    pan: 0,
    sends: [],
    inserts: slots.map((slot, index) => ({
      id: `mastering-${index}`,
      processor: slot.processor,
      params: { ...slot.params },
      enabled: true,
    })),
  };
}

/**
 * Runs one engine mastering pass over an already-bounced stereo buffer.
 *
 * The mix is scheduled as a clip at its own timeline position so the lanes'
 * absolute PPQ lines up with the rest of the render, and the pass renders the
 * stage's reported latency beyond the clip so the delayed output can be
 * realigned. The returned buffers are the same length as the input.
 *
 * @param stage The engine stage to apply.
 * @param left Left channel of the incoming mix.
 * @param right Right channel of the incoming mix.
 * @param ctx Engine factory and render-window placement.
 * @returns The processed, time-aligned stereo buffers.
 */
export async function runMasteringEnginePass(
  stage: Extract<MasteringStage, { kind: 'engine' }>,
  left: Float32Array,
  right: Float32Array,
  ctx: MasteringEnginePassContext,
): Promise<{ left: Float32Array; right: Float32Array }> {
  const frames = left.length;
  const latency = Math.max(0, Math.round(stage.latencySamples));
  const engine = ctx.createEngine(ctx.sampleRate, RENDER_BLOCK_FRAMES);
  try {
    engine.setTrackLanes([{ trackId: MASTERING_PASS_TRACK_ID }]);
    engine.setStrip(
      MASTERING_PASS_TRACK_ID,
      stripScene(MASTERING_PASS_TRACK_ID, passStrip(stage.slots)),
    );
    engine.setTempoSegments(
      ctx.tempoSegments.map((segment) => ({
        startPpq: segment.startPpq,
        bpm: segment.bpm,
        ...(segment.endBpm !== undefined ? { endBpm: segment.endBpm } : {}),
      })),
    );
    engine.setClips([
      {
        trackId: MASTERING_PASS_TRACK_ID,
        channels: [left, right],
        startPpq: ctx.startPpq,
        lengthSamples: frames,
      },
    ]);
    stage.slots.forEach((slot, insertIndex) => {
      for (const binding of slot.bindings) {
        const paramId = resolveAutomationId(() =>
          engine.resolveStripInsertAutomationId(
            MASTERING_PASS_TRACK_ID,
            insertIndex,
            binding.paramName,
          ),
        );
        if (paramId !== undefined) {
          engine.setAutomationLane(paramId, engineAutomationPoints(binding.points));
        }
      }
    });

    // The pass starts exactly where the mix does, so there is nothing before
    // it to pre-roll: one priming block with the transport stopped applies the
    // automation at the seek position and settles the parameter smoothers.
    const silentInputs = silentBlockInputs();
    engine.seekSample(ctx.startSample);
    engine.process(silentInputs(RENDER_BLOCK_FRAMES));
    engine.settleParameters();
    engine.play();

    const outLeft = new Float32Array(frames);
    const outRight = new Float32Array(frames);
    const renderFrames = frames + latency;
    let done = 0;
    let blocksSinceYield = 0;
    while (done < renderFrames) {
      const blockFrames = Math.min(RENDER_BLOCK_FRAMES, renderFrames - done);
      const out = engine.process(silentInputs(blockFrames));
      // Inserts delay their output by the latency they report; drop exactly
      // that many leading frames so the stage stays time-aligned with the mix.
      const target = done - latency;
      const skip = Math.max(0, -target);
      const copy = Math.min(blockFrames - skip, frames - Math.max(0, target));
      if (copy > 0) {
        const at = Math.max(0, target);
        outLeft.set(out[0].subarray(skip, skip + copy), at);
        outRight.set((out[1] ?? out[0]).subarray(skip, skip + copy), at);
      }
      done += blockFrames;
      ctx.checkCancel?.();
      if (++blocksSinceYield >= BLOCKS_PER_CHECKPOINT) {
        blocksSinceYield = 0;
        if (ctx.yieldBetweenBlocks) await ctx.yieldBetweenBlocks();
      }
    }
    engine.stop();
    return { left: outLeft, right: outRight };
  } finally {
    engine.destroy();
  }
}

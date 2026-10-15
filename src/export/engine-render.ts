/**
 * Engine-backed offline export renderer: builds a libsonare RealtimeEngine
 * from a plain project document, replays the project state with the same
 * pure builders the live playback sync layers use, and renders the timeline
 * by driving the engine's block processor offline. Because the audio passes
 * through the actual engine (lanes, strips, buses/sends, realtime
 * instruments, automation, tempo map), the export matches live playback by
 * construction.
 *
 * Differences from the legacy renderMixdown path it replaces:
 * - buses and sends are rendered,
 * - automation lanes are rendered,
 * - MIDI tracks play at their live engine level (no per-clip peak
 *   normalization),
 * - the full tempo map applies (renderMixdown assumed the first segment's
 *   tempo throughout).
 * The opaque mastering preset remains an export-only stage applied to the
 * bounced stereo; realtime-safe mastering processor slots are mirrored by
 * live strip sync and are applied here through the same one-shot mastering
 * processor seam after the engine bounce.
 *
 * Stems render through the same path: one extra engine pass per audible
 * track with every other lane muted, master strip/levels and the mastering
 * chain skipped (post-strip, pre-master). A track stem therefore includes the
 * track's bus/send contributions. When requested, bus/return stems render
 * extra passes that keep source lanes feeding only the selected return while
 * discarding their other direct outputs; the optional master stem is a copy of
 * the final stereo export after the master chain.
 *
 * Setup builders (bus routing, SoundFont preload, MIDI program, audio clips,
 * render window) live in engine-render-context.ts / engine-render-clips.ts;
 * shared types/constants in engine-render-types.ts and the loudness/peak
 * report in engine-render-report.ts. This module is the orchestrator: it
 * configures and drives the engine passes and re-exports the public surface.
 * When a document uses several SoundFonts, their MIDI tracks are first
 * bounced in isolated font-fixed pre-fader passes and then returned to their
 * original lanes as PCM. This avoids the engine's global SF2 slot contention
 * while keeping bus, master and mastering processing in the one final pass.
 */

import {
  engineAutomationPoints,
  engineBusInsertAutomationIndex,
  engineBusStrip,
  engineBusStripHasDsp,
  engineEqBands,
  engineFaderAutomationPoints,
  engineMasterPannerHasDsp,
} from '@/engine/engine-declaration';
import {
  type GsSysExDestination,
  MAX_REALTIME_SYSEX_BYTES,
  pushGsSetupSysex,
} from '@/engine/gs-sysex';
import { resolvePresetName } from '@/engine/instruments';
import { busSceneJson, stripSceneJson } from '@/engine/strip-sync';
import {
  estimatedTailSeconds,
  type InsertTailCatalogEntry,
  type InsertTailResolver,
  insertTailResolverFromTiming,
} from '@/export/audio-preflight';
import { planAudioClipStreams } from '@/export/clip-page-plan';
import { AudioClipStreamSession, type PagedClipSpec } from '@/export/clip-page-stream';
import {
  hasTimeVaryingPoints,
  type MasteringCapabilityLookup,
  type MasteringCatalogEntry,
  masteringCapabilityFromCatalog,
  planMasteringStages,
  runMasteringEnginePass,
} from '@/export/mastering-automation';
import { assertMasteringBufferWithinLimit } from '@/export/mastering-limit';
import { assertRenderPayloadMemory, estimateRenderPayloadMemory } from '@/export/memory-budget';
import {
  type ExportLimitation,
  MixdownCancelledError,
  type MixdownReport,
  type MixdownResult,
  type MixdownStem,
} from '@/export/mixdown';
import { peakDb } from '@/lib/db';
import { ensureWasm } from '@/lib/wasm';
import { loadAsset, loadAssetMeta } from '@/persistence/assets';
import {
  parseInsertAutomationParam,
  parseInstrumentAutomationParam,
  parseMasteringAutomationParam,
  sanitizeAutomationPoints,
} from '@/project/automation';
import { insertIndexForAutomationRef } from '@/project/automation-insert';
import { loadFont } from '@/project/fonts';
import {
  createInsertPdcPlan,
  type InsertLatencyCatalogEntry,
  type InsertLatencyResolver,
  insertLatencyResolverFromCatalog,
} from '@/project/insert-latency';
import {
  effectiveTrackInstrument,
  isNativeSynthInstrument,
  sf2PlaybackConfig,
} from '@/project/instrument';
import { midiFxConfigJson } from '@/project/midi-fx';
import {
  clampPan,
  DEFAULT_PAN_LAW,
  DEFAULT_PAN_MODE,
  effectiveTrackMute,
  laneGainDb,
  type MixerStrip,
  masteringChainIsActive,
  returnSoloRouting,
  stripHasDsp,
  tracksWithVcaSolo,
  vcaOffsetDb,
} from '@/project/mixer';
import { DEFAULT_WARP_VOICES, expandedSoloStates, MAX_WARP_VOICES } from '@/project/scheduling';
import type { ProjectDocument } from '@/project/serialization';
import { hasSoundFontSlotConflict } from '@/project/soundfont-conflicts';
import { normalizeTempoMap, samplesToPpq } from '@/project/tempo-map';
import { buildAudioClips, preflightAudioClipMemory } from './engine-render-clips';
import {
  buildBusRouting,
  busStemsBlock,
  preloadSoundFonts,
  programOutputDocument,
  resolveRenderWindow,
} from './engine-render-context';
import { buildReport } from './engine-render-report';
import {
  BLOCKS_PER_CHECKPOINT,
  busFaderParamId,
  type EngineClipSpec,
  type EngineRenderOptions,
  MAX_RELEASE_TAIL_SECONDS,
  masterParamId,
  type OfflineRenderEngine,
  RELEASE_TAIL_SECONDS,
  RENDER_BLOCK_FRAMES,
  type RenderPass,
  resolveRange,
  trackLaneParamId,
} from './engine-render-types';
import { documentTempoSegments, planExportRender } from './render-plan';

export type { EngineRenderOptions, OfflineRenderEngine } from './engine-render-types';

/**
 * Limitations to record on a render's report.
 *
 * @param doc The rendered document.
 * @param masteringFrozenParams Mastering parameters this render could not make
 *   time-varying, from {@link planMasteringStages}. Omitted (the preflight
 *   case, where no engine capability is known yet) assumes every time-varying
 *   mastering lane stays frozen.
 * @returns The limitations, in report order.
 */
export function offlineAutomationLimitations(
  doc: ProjectDocument,
  masteringFrozenParams?: ReadonlyArray<string>,
): ExportLimitation[] {
  const limitations: ExportLimitation[] = [];
  if (masteringFrozenParams === undefined) {
    const anyTimeVarying = (doc.masterAutomation ?? []).some((lane) => {
      if (!lane.enabled || !parseMasteringAutomationParam(lane.param)) return false;
      return hasTimeVaryingPoints(sanitizeAutomationPoints(lane.param, lane.points));
    });
    if (anyTimeVarying) limitations.push({ kind: 'mastering-automation-at-render-start' });
  } else if (masteringFrozenParams.length > 0) {
    limitations.push({
      kind: 'mastering-automation-at-render-start',
      params: [...masteringFrozenParams],
    });
  }
  return limitations;
}

/** Level below which a release tail counts as decayed (the engine's own tail criterion). */
const DECAYED_TAIL_LEVEL = 1e-5;

/**
 * Cuts the trailing frames after `floorFrame` that stay below
 * {@link DECAYED_TAIL_LEVEL} on every channel; frames before it are kept.
 */
export function trimDecayedTail<T extends readonly Float32Array[]>(
  channels: T,
  floorFrame: number,
): T {
  const length = channels[0]?.length ?? 0;
  let end = length;
  while (
    end > floorFrame &&
    channels.every((channel) => Math.abs(channel[end - 1]) < DECAYED_TAIL_LEVEL)
  ) {
    end -= 1;
  }
  return end === length
    ? channels
    : (channels.map((channel) => channel.slice(0, end)) as unknown as T);
}

/**
 * Renders a project document to a stereo mixdown (and optional per-track
 * stems) through offline engine instances. See the module doc comment for
 * the relation to live playback.
 *
 * @param doc Plain project document (serializeProject output or equivalent).
 * @param options Render options and injectable seams.
 * @returns The mixdown, its loudness/peak report and optional stems.
 * @throws MixdownCancelledError when options.shouldCancel returns true.
 */
export async function renderProjectWithEngine(
  input: ProjectDocument,
  options: EngineRenderOptions = {},
): Promise<MixdownResult> {
  const doc = programOutputDocument(input);
  const sampleRate = options.sampleRate ?? doc.sampleRate;
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new RangeError(`Render sample rate must be finite and > 0, got ${sampleRate}`);
  }
  if (doc.mixer?.masterLayout && doc.mixer.masterLayout !== 'stereo') {
    throw new RangeError('Surround master export is unavailable; select a stereo master layout');
  }
  const includeMasterChain = options.includeMasterChain ?? true;
  const loadAudio = options.loadAudioAsset ?? loadAsset;
  const loadAudioMeta =
    options.loadAudioAssetMeta ?? (options.loadAudioAsset === undefined ? loadAssetMeta : null);
  const loadFontBytes = options.loadFont ?? loadFont;
  let resolvePreset = options.resolvePreset ?? ((preset: string) => preset);
  let resolveInsertLatency: InsertLatencyResolver = options.insertLatency ?? (() => 0);
  let resolveInsertTail: InsertTailResolver = options.insertTail ?? (() => 0);
  const checkCancel = () => {
    if (options.shouldCancel?.()) throw new MixdownCancelledError();
  };

  const tempoSegments = documentTempoSegments(doc);
  const tempoMap = normalizeTempoMap(tempoSegments);
  const range = resolveRange(options);

  let createEngine = options.createEngine;
  let deps = options.deps;
  let resampleAudio = options.resampleAudio;
  // Without catalog metadata nothing is known to be engine-drivable, so the
  // mastering rack stays entirely on its whole-buffer path.
  let masteringCapability: MasteringCapabilityLookup =
    options.masteringCapability ?? (() => undefined);
  if (!createEngine || deps === undefined) {
    const wasm = await ensureWasm();
    resampleAudio ??= wasm.resample;
    if (!options.resolvePreset) {
      resolvePreset = (preset: string) => resolvePresetName(wasm, preset);
    }
    const catalog = (
      wasm as unknown as {
        masteringProcessorCatalog?: () => Array<
          InsertLatencyCatalogEntry & InsertTailCatalogEntry & MasteringCatalogEntry
        >;
      }
    ).masteringProcessorCatalog?.();
    if (!options.insertLatency) {
      resolveInsertLatency = insertLatencyResolverFromCatalog(
        catalog,
        sampleRate,
        wasm.masteringInsertTiming,
      );
    }
    if (!options.insertTail) {
      resolveInsertTail = insertTailResolverFromTiming(
        catalog,
        sampleRate,
        wasm.masteringInsertTiming,
      );
    }
    if (!options.masteringCapability) {
      masteringCapability = masteringCapabilityFromCatalog(catalog);
    }
    if (!createEngine) {
      createEngine = (rate, blockSize) =>
        new wasm.RealtimeEngine(rate, blockSize, 4096) as unknown as OfflineRenderEngine;
    }
    if (deps === undefined) {
      const { createWasmMixdownDeps } = await import('@/export/mixdown');
      deps = await createWasmMixdownDeps();
    }
  }

  options.onProgress?.(0, 'engine.prepare');

  // Synthetic numeric track ids: documents store tracks positionally.
  const trackIds = doc.tracks.map((_, index) => index + 1);

  // Bus/send routing, VCA offsets, solo state and lane specs (live strip-sync
  // ordering: send buses first, then one bus per group track).
  const {
    vcaGainDbById,
    vcaControlsById,
    busNumberById,
    buses,
    groupBusByTrackIndex,
    lanes,
    discardBusId,
  } = buildBusRouting(doc, trackIds);
  const tracksForSolo = tracksWithVcaSolo(doc.tracks, vcaControlsById);
  const documentSoloExpansion = {
    isGroup: (track: ProjectDocument['tracks'][number]) => track.kind === 'group',
    groupKey: (_track: ProjectDocument['tracks'][number], index: number) => index,
    memberGroupKey: (track: ProjectDocument['tracks'][number]) => track.groupIndex,
  };
  const renderPlan = planExportRender({
    doc,
    sampleRate,
    tempoMap,
    range,
    freezeTrackIndex: options.freezeTrackIndex,
    estimateTailSeconds: (contributors) =>
      estimatedTailSeconds(doc, contributors, resolveInsertTail, {
        includeMaster: includeMasterChain,
        includeMastering: includeMasterChain,
      }),
  });
  const {
    audibleTrackIndices,
    contributorTrackIndices: renderContributorIndices,
    prerollSeconds,
    contributionRange,
    midiSchedules,
    activeMidiTrackIndices,
    soundFontUsage,
  } = renderPlan;
  const effectiveInstruments = doc.tracks.map((track) =>
    track.kind === 'midi' ? effectiveTrackInstrument(track, doc.externalMidiDefault) : undefined,
  );
  const activeSf2TrackIndices = new Set(
    doc.tracks.flatMap((track, index) =>
      activeMidiTrackIndices.has(index) &&
      track.frozen === undefined &&
      effectiveInstruments[index]?.kind === 'sf2'
        ? [index]
        : [],
    ),
  );
  const conflictingSf2TrackIndices = hasSoundFontSlotConflict(soundFontUsage)
    ? new Set(activeSf2TrackIndices)
    : new Set<number>();
  if (conflictingSf2TrackIndices.size > 0) {
    const hasCrossFontKey = [...conflictingSf2TrackIndices].some((targetIndex) =>
      doc.tracks[targetIndex].mixer?.inserts.some((slot) => {
        const sourceIndex = (slot as { sidechainSourceIndex?: number }).sidechainSourceIndex;
        return (
          slot.enabled &&
          sourceIndex !== undefined &&
          sourceIndex !== targetIndex &&
          activeSf2TrackIndices.has(sourceIndex)
        );
      }),
    );
    if (hasCrossFontKey) {
      throw new RangeError(
        'A SoundFont track keyed by another active SoundFont cannot be rendered accurately with conflicting fonts',
      );
    }
  }

  // A group return is audible when either the group itself passes the shared
  // mute/solo projection or one of its routed members does. The latter matters
  // when a child is soloed: its audio still flows through the non-muted group
  // bus even though the group's silent control lane is not itself soloed.
  const audibleStemTrackIndices = new Set(audibleTrackIndices);
  doc.tracks.forEach((track, trackIndex) => {
    if (track.kind !== 'group') return;
    if (effectiveTrackMute(track.mute, track.vcaId, vcaControlsById)) return;
    if (
      doc.tracks.some(
        (member, memberIndex) =>
          member.groupIndex === trackIndex && audibleTrackIndices.has(memberIndex),
      )
    ) {
      audibleStemTrackIndices.add(trackIndex);
    }
  });
  const groupStemIndices = new Set(
    doc.tracks.flatMap((track, trackIndex) =>
      track.kind === 'group' && audibleStemTrackIndices.has(trackIndex) ? [trackIndex] : [],
    ),
  );
  const stemTracks = options.stems
    ? doc.tracks
        .map((track, trackIndex) => ({ track, trackIndex }))
        .filter(({ track, trackIndex }) => {
          if (!audibleStemTrackIndices.has(trackIndex)) return false;
          // A group stem owns all of its member lanes. Emitting both would
          // duplicate the same routed signal when the stems are re-summed.
          if (track.groupIndex !== undefined && groupStemIndices.has(track.groupIndex)) {
            return false;
          }
          // When return stems are requested, a track whose primary output is a
          // return bus is represented by that bus stem rather than a bypassed
          // duplicate of it.
          return !(
            options.busStems === true &&
            track.kind !== 'group' &&
            track.mixer?.outputBusId !== undefined
          );
        })
    : [];
  const stemBuses =
    options.stems && options.busStems === true
      ? (doc.mixer?.buses ?? [])
          .map((bus, busIndex) => ({ bus, busIndex }))
          .flatMap(({ bus, busIndex }) => {
            const busNumber = busNumberById.get(bus.id);
            return busNumber === undefined ? [] : [{ bus, busIndex, busNumber }];
          })
      : [];
  if (stemBuses.length > 0) {
    const block = busStemsBlock(doc, { buses, discardBusId });
    if (block === 'bus-graph-full') {
      throw new RangeError('Return stems require one free engine bus for isolation');
    }
    if (block === 'nested-routing') {
      throw new RangeError('Return stems cannot isolate nested bus routing or bus sidechain keys');
    }
  }
  const stemCount =
    stemTracks.length + stemBuses.length + (options.stems && options.masterStem === true ? 1 : 0);
  const chain = doc.mixer?.masteringChain;
  const mastering = deps?.mastering ?? null;
  // Plan once before any render PCM is allocated. The same plan is reused
  // below when applying the rack, so the guard and the actual path cannot
  // disagree about whether a stage is whole-buffer or engine-driven.
  const masteringPlan =
    includeMasterChain && chain && masteringChainIsActive(chain) && mastering
      ? planMasteringStages(chain, doc.masterAutomation ?? [], range.startPpq, masteringCapability)
      : null;
  const hasFullBufferMastering =
    includeMasterChain &&
    chain !== undefined &&
    masteringChainIsActive(chain) &&
    (deps?.mastering ?? null) !== null;
  // Integrated loudness and dynamic-range measurement require the complete
  // deliverable. The streaming WAV path deliberately reports peakDb only.
  const streamingMixdownEligible =
    options.onMixdownChunk !== undefined &&
    stemCount === 0 &&
    conflictingSf2TrackIndices.size === 0 &&
    !hasFullBufferMastering;

  // Clips whose stored asset already holds exactly the frames they play are
  // paged through the engine instead of being decoded, so the render's peak
  // payload stops growing with the project's total PCM. Planning reads only
  // sidecars, and it must run before the preflight so those clips drop out of
  // the estimate they no longer contribute to.
  const clipStreamPlans =
    loadAudioMeta && options.createClipPageStream
      ? await planAudioClipStreams(doc, {
          trackIds,
          tempoMap,
          sampleRate,
          loadAudioMeta,
          checkCancel,
          range: contributionRange,
          audibleTrackIndices: renderContributorIndices,
        })
      : [];
  const streamedKeys = new Set(clipStreamPlans.map((plan) => plan.key));
  const audioMemory = loadAudioMeta
    ? await preflightAudioClipMemory(doc, {
        sampleRate,
        tempoMap,
        loadAudioMeta,
        checkCancel,
        range: contributionRange,
        audibleTrackIndices: renderContributorIndices,
        streamedKeys,
      })
    : { sourceAudioBytes: 0, preparedClipBytes: 0, audioWindowClips: [] };
  const preflightWindow = resolveRenderWindow(
    doc,
    tempoMap,
    range,
    sampleRate,
    options.releaseTailSeconds,
    audioMemory.audioWindowClips,
    renderContributorIndices,
    options.appendReleaseTailForExplicitRange,
  );
  assertMasteringBufferWithinLimit({
    totalFrames: preflightWindow.totalFrames,
    sampleRate,
    includeMasterChain,
    usesPreset:
      masteringPlan !== null && chain?.preset !== undefined && mastering?.applyPreset !== undefined,
    wholeBufferProcessorCount:
      masteringPlan?.stages.filter((stage) => stage.kind === 'whole-buffer').length ?? 0,
  });
  if (options.memoryBudgetBytes !== undefined) {
    assertRenderPayloadMemory(
      estimateRenderPayloadMemory({
        totalFrames: preflightWindow.totalFrames,
        stemCount,
        streamingStems: options.onStem !== undefined,
        streamingMixdown: streamingMixdownEligible,
        transientStereoBuffers: streamingMixdownEligible ? 0 : undefined,
        retainedAuxiliaryStereoBuffers: conflictingSf2TrackIndices.size,
        sourceAudioBytes: audioMemory.sourceAudioBytes,
        preparedClipBytes: audioMemory.preparedClipBytes,
      }),
      options.memoryBudgetBytes,
    );
  }

  const mediaIssues: NonNullable<MixdownReport['mediaIssues']> = [];
  let warnedUnsupportedGsSysex = false;
  // Pre-load instrument fonts only after the metadata-only audio preflight.
  // A missing font must not turn into a raw storage error: finish the render
  // with a structured issue so the export dialog can explain and block it.
  const fontBytesById = await preloadSoundFonts(
    doc,
    loadFontBytes,
    activeMidiTrackIndices,
    (id, error) => {
      mediaIssues.push({
        kind: 'soundfont',
        id,
        reason: 'missing-or-unreadable',
        message: error instanceof Error ? error.message : String(error),
      });
    },
  );
  const soundFontBytes = [...fontBytesById.values()].reduce(
    (sum, bytes) => sum + bytes.byteLength,
    0,
  );
  if (options.memoryBudgetBytes !== undefined) {
    assertRenderPayloadMemory(
      estimateRenderPayloadMemory({
        totalFrames: preflightWindow.totalFrames,
        stemCount,
        streamingStems: options.onStem !== undefined,
        streamingMixdown: streamingMixdownEligible,
        transientStereoBuffers: streamingMixdownEligible ? 0 : undefined,
        retainedAuxiliaryStereoBuffers: conflictingSf2TrackIndices.size,
        sourceAudioBytes: audioMemory.sourceAudioBytes,
        preparedClipBytes: audioMemory.preparedClipBytes,
        soundFontBytes,
      }),
      options.memoryBudgetBytes,
    );
  }

  // Audio clips: the live scheduling transforms (slice window, baked fades),
  // then WASM's offline-quality resample to the render rate, at their timeline PPQ.
  const sourceAudioClips = await buildAudioClips(doc, {
    trackIds,
    tempoMap,
    sampleRate,
    loadAudio,
    resampleAudio: async (samples, sourceRate, targetRate) => {
      resampleAudio ??= (await ensureWasm()).resample;
      return resampleAudio(samples, sourceRate, targetRate);
    },
    checkCancel,
    mediaIssues,
    range: contributionRange,
    audibleTrackIndices: renderContributorIndices,
    streamedKeys,
  });

  // Project documents use positional `groupIndex` membership while the live
  // editor plan uses stable numeric track ids in `groupId`. Build the exact
  // equivalent identity graph before deriving PDC, otherwise group-bus insert
  // latency is silently omitted from offline compensation.
  const pdcTracks = doc.tracks.map((track, index) => ({
    id: trackIds[index],
    kind: track.kind,
    ...(track.frozen !== undefined ? { frozen: track.frozen } : {}),
    ...(track.groupIndex !== undefined && trackIds[track.groupIndex] !== undefined
      ? { groupId: trackIds[track.groupIndex] }
      : {}),
    ...(track.mixer !== undefined ? { mixer: track.mixer } : {}),
  }));
  const pdc = createInsertPdcPlan(pdcTracks, doc.mixer?.buses ?? [], resolveInsertLatency);
  const returnSolo = returnSoloRouting(doc.mixer?.buses ?? []);
  let renderAudioClips: EngineClipSpec[] = sourceAudioClips;

  /** Replays the pre-built program onto a fresh engine (synchronous). */
  const configureEngine = (
    engine: OfflineRenderEngine,
    pass: RenderPass,
    pagedClips: ReadonlyArray<PagedClipSpec> = [],
    includeClips = true,
  ): void => {
    const supportsBusEq = typeof engine.setBusStripEqBandJson === 'function';
    const supportsBusInsertBypass = typeof engine.setBusStripInsertBypassed === 'function';
    // The engine validates sends against already-declared buses, so the bus
    // set must be installed before any lane that carries sends. A freeze pass
    // strips the frozen lane's sends (they stay live on the track). A bus stem
    // pass adds a silent discard bus so non-selected direct outputs can be
    // removed while selected sends/outputs still feed the return.
    const silentBusId =
      pass.busStemId === null
        ? null
        : (discardBusId ?? buses.reduce((max, bus) => Math.max(max, bus.busId), 0) + 1);
    const passBuses =
      silentBusId === null || discardBusId === silentBusId
        ? buses
        : [...buses, { busId: silentBusId, gainDb: -120 }];
    if (passBuses.length > 0) engine.setTrackBuses(passBuses);
    // A muted lane can still feed a pre-fader send: libsonare taps it before
    // the lane's mute/solo gate. An isolated render must remove sends from
    // every non-selected lane while retaining its lane for sidechain state.
    const isolatedLanes =
      pass.stemIndices === null
        ? lanes
        : lanes.map((lane, index) =>
            pass.stemIndices?.has(index) ? lane : { trackId: lane.trackId },
          );
    const passLanes =
      pass.freezeIndex !== null
        ? isolatedLanes.map((lane, index) =>
            index === pass.freezeIndex ? { trackId: lane.trackId } : lane,
          )
        : pass.busStemId !== null && silentBusId !== null
          ? isolatedLanes.map((lane) => {
              const sends = lane.sends?.filter((send) => send.busId === pass.busStemId) ?? [];
              const outputBusId =
                lane.outputBusId === pass.busStemId ? pass.busStemId : silentBusId;
              return {
                trackId: lane.trackId,
                ...(sends.length > 0 ? { sends } : {}),
                outputBusId,
              };
            })
          : pass.stemIndices !== null && pass.stemRouting !== 'document'
            ? isolatedLanes.map((lane, index) => {
                if (!pass.stemIndices?.has(index)) return lane;
                return {
                  trackId: lane.trackId,
                  ...(!pass.separateReturnStems && lane.sends?.length ? { sends: lane.sends } : {}),
                  ...(pass.stemRouting === 'group' && lane.outputBusId !== undefined
                    ? { outputBusId: lane.outputBusId }
                    : {}),
                };
              })
            : isolatedLanes;
    engine.setTrackLanes(passLanes);

    for (const bus of doc.mixer?.buses ?? []) {
      const busId = busNumberById.get(bus.id);
      if (busId === undefined) continue;
      if (!engineBusStripHasDsp(bus.strip, supportsBusEq)) continue;
      const engineStrip = supportsBusInsertBypass ? bus.strip : engineBusStrip(bus.strip);
      engine.setBusStripJson(
        busId,
        busSceneJson(busId, engineStrip, undefined, {
          includeEq: supportsBusEq,
          channelLayout: bus.channelLayout,
        }),
      );
      if (supportsBusInsertBypass) {
        bus.strip?.inserts.forEach((slot, insertIndex) => {
          engine.setBusStripInsertBypassed?.(busId, insertIndex, !slot.enabled);
        });
      }
      if (supportsBusEq) {
        engineEqBands(bus.strip).forEach((band, bandIndex) => {
          engine.setBusStripEqBandJson?.(busId, bandIndex, JSON.stringify(band));
        });
      }
    }

    // Per-track strips (inserts + EQ + bypass flags), lane base fader/pan and
    // solo/mute — the same state the live mixer/strip syncs install. A stem
    // pass instead isolates one lane by muting every other one (solo would
    // also keep the document's own soloed tracks audible).
    const soloStates = expandedSoloStates(tracksForSolo, documentSoloExpansion);
    doc.tracks.forEach((track, index) => {
      const strip = track.mixer;
      const trackId = trackIds[index];
      const usesPreRenderedSf2 = pass.usePreRenderedSf2 && conflictingSf2TrackIndices.has(index);
      if (track.kind === 'group') {
        // Group inserts ride the group's bus strip (the lane stays silent);
        // the audible group level was already baked into the bus gain.
        const busId = groupBusByTrackIndex.get(index);
        if (busId !== undefined && engineBusStripHasDsp(strip, supportsBusEq)) {
          const engineStrip = supportsBusInsertBypass ? strip : engineBusStrip(strip);
          engine.setBusStripJson(
            busId,
            busSceneJson(busId, engineStrip, undefined, { includeEq: supportsBusEq }),
          );
          if (supportsBusInsertBypass) {
            strip?.inserts.forEach((slot, insertIndex) => {
              engine.setBusStripInsertBypassed?.(busId, insertIndex, !slot.enabled);
            });
          }
          if (supportsBusEq) {
            engineEqBands(strip).forEach((band, bandIndex) => {
              engine.setBusStripEqBandJson?.(busId, bandIndex, JSON.stringify(band));
            });
          }
        }
        return;
      }
      // A channel-delay target must already have a strip in libsonare. Keep
      // the declaration decision separate from the store strip: frozen lanes
      // and SF2 pre-render lanes deliberately bypass their stored DSP, so
      // they need the same neutral declaration before receiving PDC.
      const hasDeclaredTrackStrip =
        track.frozen === undefined && !usesPreRenderedSf2 && stripHasDsp(strip);
      if (hasDeclaredTrackStrip && strip) {
        // Frozen tracks bypass their strip DSP (baked into the render).
        engine.setTrackStripJson(trackId, stripSceneJson(trackId, strip));
        strip.inserts.forEach((slot, insertIndex) => {
          engine.setTrackStripInsertBypassed(trackId, insertIndex, !slot.enabled);
        });
        engineEqBands(strip).forEach((band, bandIndex) => {
          engine.setTrackStripEqBandJson(trackId, bandIndex, JSON.stringify(band));
        });
      }
      const channelDelay = pdc.delayFor(pdcTracks[index]);
      if (pass.freezeIndex !== index && channelDelay > 0 && !hasDeclaredTrackStrip) {
        // libsonare rejects channel-delay setters for lanes without a strip
        // scene. Install this neutral scene before the panner setters below;
        // replacing a scene must not erase a lane's pan mode or dual-pan.
        engine.setTrackStripJson(trackId, stripSceneJson(trackId, undefined));
      }
      if (pass.stemIndices === null) {
        // Solo-safe lanes and routed group members stay in the effective solo
        // group while any solo is active.
        engine.setSoloMute(
          index,
          soloStates[index] ?? false,
          effectiveTrackMute(track.mute, track.vcaId, vcaControlsById),
        );
      } else {
        engine.setSoloMute(index, false, !pass.stemIndices.has(index));
      }
      if (pass.freezeIndex === index) {
        // Pre-fader freeze: the lane renders at unity/centered with neutral pan
        // shaping; the live fader/pan/pan-law keep applying to the baked audio.
        engine.setParameter(trackLaneParamId(engine, trackId, 'faderDb'), 0);
        engine.setParameter(trackLaneParamId(engine, trackId, 'pan'), 0);
      } else {
        // Lane fader includes the strip trim and the track's VCA group offset,
        // so a VCA-attenuated track exports at the level it plays back at.
        engine.setParameter(
          trackLaneParamId(engine, trackId, 'faderDb'),
          laneGainDb(track.volume, strip?.gainDb, vcaOffsetDb(track.vcaId, vcaGainDbById)),
        );
        // MixerStrip.pan is canonical. Fall back to DocumentTrack.pan so
        // pre-migration projects and freshly imported foreign documents pan
        // identically before and after a save/load cycle.
        const pan = clampPan(strip?.pan ?? track.pan ?? 0);
        engine.setParameter(trackLaneParamId(engine, trackId, 'pan'), pan);
        // Pan law / mode / dual-pan / channel-delay shape the lane exactly as
        // live mixer-sync does; emit only the non-defaults to keep the command
        // budget small (the engine starts each lane at these defaults).
        const panLaw = strip?.panLaw ?? DEFAULT_PAN_LAW;
        if (panLaw !== DEFAULT_PAN_LAW) engine.setTrackStripPanLaw(trackId, panLaw);
        const panMode = strip?.panMode ?? DEFAULT_PAN_MODE;
        if (panMode !== DEFAULT_PAN_MODE) engine.setTrackStripPanMode(trackId, panMode);
        if (strip?.dualPan) {
          engine.setTrackStripDualPan(
            trackId,
            clampPan(strip.dualPan.left),
            clampPan(strip.dualPan.right),
          );
        }
        // The pre-rendered SF2 PCM contains the insert processor's own
        // latency, but not the live PDC channel delay (freeze passes keep it
        // outside the bake), so the final lane still receives normal PDC.
        if (channelDelay > 0) engine.setTrackStripChannelDelaySamples(trackId, channelDelay);
      }
    });

    // Insert sidechain keys (document inserts carry positional sources).
    doc.tracks.forEach((track, index) => {
      const usesPreRenderedSf2 = pass.usePreRenderedSf2 && conflictingSf2TrackIndices.has(index);
      if (track.kind === 'group' || usesPreRenderedSf2) return;
      (track.mixer?.inserts ?? []).forEach((slot, insertIndex) => {
        const sourceIndex = (slot as { sidechainSourceIndex?: number }).sidechainSourceIndex;
        if (
          sourceIndex === undefined ||
          !Number.isInteger(sourceIndex) ||
          sourceIndex < 0 ||
          sourceIndex >= doc.tracks.length ||
          sourceIndex === index
        ) {
          return;
        }
        engine.setLaneSidechain(trackIds[index], insertIndex, trackIds[sourceIndex]);
      });
    });

    // Bus and master keys are attached after their insert scenes exist. A
    // document stores track/group references positionally and return bus keys
    // by stable bus id; resolve them to this render pass's compact engine IDs.
    const sidechainSource = (slot: unknown): { kind: number; id: number } | null => {
      if (!slot || typeof slot !== 'object') return null;
      const source = slot as {
        sidechainSourceIndex?: number;
        sidechainSourceBusId?: string;
        sidechainSourceGroupTrackIndex?: number;
      };
      if (
        Number.isInteger(source.sidechainSourceIndex) &&
        (source.sidechainSourceIndex as number) >= 0 &&
        (source.sidechainSourceIndex as number) < trackIds.length
      ) {
        return { kind: 0, id: trackIds[source.sidechainSourceIndex as number] };
      }
      if (source.sidechainSourceBusId !== undefined) {
        const id = busNumberById.get(source.sidechainSourceBusId);
        if (id !== undefined) return { kind: 1, id };
      }
      if (source.sidechainSourceGroupTrackIndex !== undefined) {
        const id = groupBusByTrackIndex.get(source.sidechainSourceGroupTrackIndex);
        if (id !== undefined) return { kind: 1, id };
      }
      return null;
    };
    const keyBusInsert = (
      busId: number,
      strip: MixerStrip | undefined,
      insertIndex: number,
      slot: unknown,
    ): void => {
      const source = sidechainSource(slot);
      if (!source) return;
      const engineIndex = engineBusInsertAutomationIndex(
        strip,
        insertIndex,
        supportsBusInsertBypass,
      );
      if (engineIndex === undefined) return;
      if (!engine.setBusSidechain) throw new Error('Engine does not support bus sidechains');
      engine.setBusSidechain(busId, engineIndex, source.kind, source.id);
    };
    for (const bus of doc.mixer?.buses ?? []) {
      const busId = busNumberById.get(bus.id);
      if (busId === undefined) continue;
      bus.strip?.inserts.forEach((slot, insertIndex) => {
        keyBusInsert(busId, bus.strip, insertIndex, slot);
      });
    }
    doc.tracks.forEach((track, index) => {
      if (track.kind !== 'group') return;
      const busId = groupBusByTrackIndex.get(index);
      if (busId === undefined) return;
      track.mixer?.inserts.forEach((slot, insertIndex) => {
        keyBusInsert(busId, track.mixer, insertIndex, slot);
      });
    });

    // Master strip: inserts/EQ only with the chain enabled; gain/pan whenever
    // the pass renders master levels (stems are pre-master).
    const master = doc.mixer?.master;
    // `liveMasterStrip` is strictly a preview optimization. Offline export
    // keeps the master strip independent, then applies the entire mastering
    // rack after its preset in declared order below.
    const masterStrip = master;
    if (
      pass.masterStrip &&
      masterStrip &&
      (stripHasDsp(masterStrip) || engineMasterPannerHasDsp(masterStrip))
    ) {
      engine.setMasterStripJson(stripSceneJson('master', masterStrip));
      masterStrip.inserts.forEach((slot, insertIndex) => {
        engine.setMasterStripInsertBypassed(insertIndex, !slot.enabled);
      });
      engineEqBands(masterStrip).forEach((band, bandIndex) => {
        engine.setMasterStripEqBandJson(bandIndex, JSON.stringify(band));
      });
      masterStrip.inserts.forEach((slot, insertIndex) => {
        const source = sidechainSource(slot);
        if (!source) return;
        if (!engine.setMasterSidechain)
          throw new Error('Engine does not support master sidechains');
        engine.setMasterSidechain(insertIndex, source.kind, source.id);
      });
    }
    if (pass.masterLevels) {
      engine.setParameter(masterParamId(engine, 'faderDb'), master?.gainDb ?? 0);
      engine.setParameter(masterParamId(engine, 'pan'), clampPan(master?.pan ?? 0));
    }

    // Automation lanes (track entries + master), enabled lanes only.
    doc.tracks.forEach((track, index) => {
      const usesPreRenderedSf2 = pass.usePreRenderedSf2 && conflictingSf2TrackIndices.has(index);
      for (const lane of track.automation ?? []) {
        if (!lane.enabled || lane.points.length === 0) continue;
        if (pass.freezeIndex === index && (lane.param === 'faderDb' || lane.param === 'pan')) {
          continue;
        }
        const points =
          lane.param === 'faderDb'
            ? engineFaderAutomationPoints(
                lane.points,
                vcaOffsetDb(track.vcaId, vcaGainDbById),
                effectiveTrackMute(track.mute, track.vcaId, vcaControlsById),
              )
            : engineAutomationPoints(lane.points);
        if (points.length === 0) continue;
        // Insert-parameter lanes resolve to the engine's reserved insert id
        // (and strip selector) from the strip state already installed above; a
        // negative id means the insert or key is unknown and is skipped.
        const insertRef = parseInsertAutomationParam(lane.param);
        if (insertRef) {
          if (usesPreRenderedSf2) continue;
          const storeInsertIndex = insertIndexForAutomationRef(
            track.mixer?.inserts ?? [],
            insertRef,
          );
          if (storeInsertIndex === undefined) continue;
          const groupBusId = track.kind === 'group' ? groupBusByTrackIndex.get(index) : undefined;
          if (groupBusId !== undefined) {
            const insertIndex = engineBusInsertAutomationIndex(
              track.mixer,
              storeInsertIndex,
              supportsBusInsertBypass,
            );
            if (insertIndex === undefined) continue;
            const id = engine.resolveBusInsertAutomationId(
              groupBusId,
              insertIndex,
              insertRef.paramName,
            );
            if (id >= 0) engine.setAutomationLane(id, points);
            continue;
          }
          const id = engine.resolveTrackInsertAutomationId(
            trackIds[index],
            storeInsertIndex,
            insertRef.paramName,
          );
          if (id >= 0) engine.setAutomationLane(id, points);
          continue;
        }
        if (parseInstrumentAutomationParam(lane.param)) continue;
        if (lane.param !== 'faderDb' && lane.param !== 'pan') continue;
        const groupBusId = track.kind === 'group' ? groupBusByTrackIndex.get(index) : undefined;
        if (groupBusId !== undefined) {
          if (
            lane.param === 'faderDb' &&
            !returnSolo.active &&
            !effectiveTrackMute(track.mute, track.vcaId, vcaControlsById)
          ) {
            engine.setAutomationLane(busFaderParamId(engine, groupBusId), points);
          }
          continue;
        }
        engine.setAutomationLane(trackLaneParamId(engine, trackIds[index], lane.param), points);
      }
    });
    if (pass.masterLevels) {
      for (const lane of doc.masterAutomation ?? []) {
        if (!lane.enabled || lane.points.length === 0) continue;
        const points = engineAutomationPoints(lane.points);
        if (points.length === 0) continue;
        const insertRef = parseInsertAutomationParam(lane.param);
        if (insertRef) {
          const storeInsertIndex = insertIndexForAutomationRef(
            doc.mixer?.master.inserts ?? [],
            insertRef,
          );
          if (storeInsertIndex === undefined) continue;
          const id = engine.resolveMasterInsertAutomationId(storeInsertIndex, insertRef.paramName);
          if (id >= 0) engine.setAutomationLane(id, points);
          continue;
        }
        if (parseMasteringAutomationParam(lane.param)) continue;
        if (lane.param !== 'faderDb' && lane.param !== 'pan') continue;
        engine.setAutomationLane(masterParamId(engine, lane.param), points);
      }
    }
    for (const bus of doc.mixer?.buses ?? []) {
      const busId = busNumberById.get(bus.id);
      if (busId === undefined) continue;
      for (const lane of bus.automation ?? []) {
        // A muted/non-selected return must override fader automation for the
        // whole render. The stored lane remains intact and resumes when the
        // temporary routing state is released.
        if (
          lane.param === 'faderDb' &&
          (bus.mute === true || (returnSolo.active && !returnSolo.isSoloed(bus.id)))
        )
          continue;
        if (!lane.enabled || lane.points.length === 0) continue;
        const points = engineAutomationPoints(lane.points);
        if (points.length === 0) continue;
        const insertRef = parseInsertAutomationParam(lane.param);
        if (insertRef) {
          const storeInsertIndex = insertIndexForAutomationRef(bus.strip?.inserts ?? [], insertRef);
          if (storeInsertIndex === undefined) continue;
          const insertIndex = engineBusInsertAutomationIndex(
            bus?.strip,
            storeInsertIndex,
            supportsBusInsertBypass,
          );
          if (insertIndex === undefined) continue;
          const id = engine.resolveBusInsertAutomationId(busId, insertIndex, insertRef.paramName);
          if (id >= 0) engine.setAutomationLane(id, points);
          continue;
        }
        if (lane.param !== 'faderDb') continue;
        engine.setAutomationLane(busFaderParamId(engine, busId), points);
      }
    }

    engine.setTempoSegments(
      tempoSegments.map((s) => ({ startPpq: s.startPpq, bpm: s.bpm, endBpm: s.endBpm ?? 0 })),
    );

    // Instruments for MIDI tracks use the same resolution as live playback.
    // A regular pass can bind all SF2 destinations only when they share one
    // font. Conflicting projects first run isolated, font-fixed pre-fader
    // bounces; their final pass binds no SF2 player and schedules those
    // bounces as audio on the original lanes instead.
    let loadedFontId: string | undefined;
    const boundSf2Destinations: GsSysExDestination[] = [];
    for (let index = 0; index < doc.tracks.length; index++) {
      const track = doc.tracks[index];
      if (track.kind !== 'midi') continue;
      if (track.frozen !== undefined) continue;
      const instrument = effectiveInstruments[index];
      const destinationId = trackIds[index];
      if (instrument?.kind === 'synth-preset') {
        const preset = resolvePreset(instrument.preset);
        engine.setSynthInstrument(
          instrument.useGmPrograms === true ? { preset, useGmPrograms: true } : preset,
          destinationId,
        );
      } else if (instrument?.kind === 'synth-patch') {
        engine.setSynthInstrument(instrument.patch, destinationId);
      } else if (instrument?.kind === 'sf2') {
        if (pass.sf2TrackIndices !== null && !pass.sf2TrackIndices.has(index)) continue;
        const bytes = fontBytesById.get(instrument.fontId);
        if (bytes && instrument.fontId !== loadedFontId) {
          engine.loadSoundFont(bytes);
          loadedFontId = instrument.fontId;
        }
        engine.setSf2Instrument(sf2PlaybackConfig(instrument), destinationId);
        if (bytes !== undefined) {
          boundSf2Destinations.push({
            destinationId,
            bindingKey: JSON.stringify({ instrument, fontId: instrument.fontId }),
          });
        }
      }
      // Instrument lanes resolve against the instrument just bound, as live.
      if (instrument !== undefined && isNativeSynthInstrument(instrument)) {
        for (const lane of track.automation ?? []) {
          const ref = lane.enabled ? parseInstrumentAutomationParam(lane.param) : undefined;
          if (!ref) continue;
          const points = engineAutomationPoints(lane.points);
          const id = engine.resolveInstrumentAutomationId(destinationId, ref.paramName);
          if (points.length > 0 && id >= 0) engine.setAutomationLane(id, points);
        }
      }
      // External-MIDI tracks have no internal instrument and no external device
      // during an offline render, so they bind nothing here and stay silent.
      // Apply the track's live, non-destructive MIDI-FX insert so the export
      // matches live playback (the same engine transform, applied here rather
      // than baked into the notes).
      if (
        track.midiFx !== undefined &&
        (instrument?.kind !== 'sf2' ||
          pass.sf2TrackIndices === null ||
          pass.sf2TrackIndices.has(index))
      ) {
        const json = midiFxConfigJson(track.midiFx);
        if (json !== null) engine.setMidiFx(destinationId, json);
      }
    }

    const gsSetup = pushGsSetupSysex(
      engine,
      doc.tracks.flatMap((track) => track.clips),
      boundSf2Destinations,
    );
    if (gsSetup.unsupportedPacketCount > 0 && !warnedUnsupportedGsSysex) {
      console.warn(
        `Offline render: ${gsSetup.unsupportedPacketCount} SMF SysEx packet(s) were kept for SMF roundtrip and not applied to realtime GS instruments (only complete setup frames at PPQ 0 up to ${MAX_REALTIME_SYSEX_BYTES} bytes are supported).`,
      );
      warnedUnsupportedGsSysex = true;
    }

    const passMidiSchedules = midiSchedules.filter((schedule) => {
      const trackIndex =
        schedule.destinationId === undefined ? undefined : schedule.destinationId - 1;
      if (trackIndex !== undefined && effectiveInstruments[trackIndex]?.kind === 'external-midi') {
        return false;
      }
      return (
        !pass.usePreRenderedSf2 ||
        trackIndex === undefined ||
        !conflictingSf2TrackIndices.has(trackIndex)
      );
    });
    if (passMidiSchedules.length > 0) engine.setMidiClips(passMidiSchedules);
    // A paged clip carries a provider where a decoded clip carries channels;
    // the engine accepts either form in the same schedule.
    const passClips: Array<EngineClipSpec | PagedClipSpec> =
      pagedClips.length > 0 ? [...renderAudioClips, ...pagedClips] : renderAudioClips;
    // Every warped clip gets a stretch voice, up to the engine's ceiling.
    const warpedClips = renderAudioClips.filter((clip) => clip.warpMode === 'time-stretch').length;
    engine.setWarpVoiceCapacity(
      Math.min(MAX_WARP_VOICES, Math.max(DEFAULT_WARP_VOICES, warpedClips)),
    );
    if (includeClips && passClips.length > 0) engine.setClips(passClips as EngineClipSpec[]);
  };

  // The engine reports the longest audible tail once the program is installed;
  // a throwaway engine holding only the strips and instruments measures it.
  const freezeIndex = options.freezeTrackIndex;
  if (freezeIndex !== undefined) {
    if (!Number.isInteger(freezeIndex) || freezeIndex < 0 || freezeIndex >= doc.tracks.length) {
      throw new RangeError(`Freeze track index ${freezeIndex} is out of range`);
    }
    if (doc.tracks[freezeIndex].kind === 'group') {
      throw new RangeError('Group tracks cannot be frozen');
    }
  }
  const freezePass: RenderPass | null =
    freezeIndex === undefined
      ? null
      : {
          masterStrip: false,
          masterLevels: false,
          stemIndices: new Set([freezeIndex]),
          stemRouting: 'document',
          separateReturnStems: false,
          busStemId: null,
          freezeIndex,
          sf2TrackIndices: activeSf2TrackIndices.has(freezeIndex)
            ? new Set([freezeIndex])
            : new Set(),
          usePreRenderedSf2: false,
        };
  let releaseTailSeconds = options.releaseTailSeconds;
  if (options.releaseTailFromEngine) {
    const probe = (createEngine as NonNullable<typeof createEngine>)(
      sampleRate,
      RENDER_BLOCK_FRAMES,
    );
    try {
      configureEngine(
        probe,
        freezePass ?? {
          masterStrip: includeMasterChain,
          masterLevels: true,
          stemIndices: null,
          stemRouting: 'document',
          separateReturnStems: false,
          busStemId: null,
          freezeIndex: null,
          sf2TrackIndices: activeSf2TrackIndices,
          usePreRenderedSf2: false,
        },
        [],
        false,
      );
      const tailSamples = probe.tailSamples?.();
      if (tailSamples !== undefined && Number.isFinite(tailSamples) && tailSamples >= 0) {
        releaseTailSeconds = Math.min(MAX_RELEASE_TAIL_SECONDS, tailSamples / sampleRate);
      }
    } finally {
      probe.destroy();
    }
  }

  // Resolve the render window in frames. Paged clips carry no buffer, so the
  // window has to hear about them through their planned length.
  const { startSample, totalFrames } = resolveRenderWindow(
    doc,
    tempoMap,
    range,
    sampleRate,
    releaseTailSeconds,
    [
      ...sourceAudioClips,
      ...clipStreamPlans.map((plan) => ({
        startPpq: plan.startPpq,
        lengthSamples: plan.frameCount,
      })),
    ],
    renderContributorIndices,
    options.appendReleaseTailForExplicitRange,
  );
  // Asset metadata is optional for injected render dependencies. Prepared
  // audio can extend the final window beyond the earlier inexpensive estimate.
  assertMasteringBufferWithinLimit({
    totalFrames,
    sampleRate,
    includeMasterChain,
    usesPreset:
      masteringPlan !== null && chain?.preset !== undefined && mastering?.applyPreset !== undefined,
    wholeBufferProcessorCount:
      masteringPlan?.stages.filter((stage) => stage.kind === 'whole-buffer').length ?? 0,
  });
  if (options.memoryBudgetBytes !== undefined) {
    const preparedClipBytes = sourceAudioClips.reduce(
      (sum, clip) =>
        sum + clip.channels.reduce((channelSum, channel) => channelSum + channel.byteLength, 0),
      0,
    );
    assertRenderPayloadMemory(
      estimateRenderPayloadMemory({
        totalFrames,
        stemCount,
        streamingStems: options.onStem !== undefined,
        streamingMixdown: streamingMixdownEligible,
        transientStereoBuffers: streamingMixdownEligible ? 0 : undefined,
        retainedAuxiliaryStereoBuffers: conflictingSf2TrackIndices.size,
        sourceAudioBytes: audioMemory.sourceAudioBytes,
        preparedClipBytes,
        soundFontBytes,
      }),
      options.memoryBudgetBytes,
    );
  }

  /**
   * Drives one engine pass block by block over the render window, mapping its
   * progress onto [progressStart, progressStart + progressSpan]. Lane faders
   * and other engine parameters are smoothed, so a freshly built engine would
   * ramp them in from their defaults over the first audible milliseconds. One
   * priming block with the transport stopped (drains queued commands and
   * applies automation at the seek position, nothing sounds) followed by
   * settleParameters snaps every smoother to its target before play.
   */
  const renderWindow = async (
    engine: OfflineRenderEngine,
    stage: string,
    progressStart: number,
    progressSpan: number,
    capturePreroll = false,
    onChunk?: (
      channels: readonly [Float32Array, Float32Array],
      offsetFrames: number,
    ) => Promise<void> | void,
    streams?: AudioClipStreamSession,
  ): Promise<[Float32Array, Float32Array]> => {
    // Roll (and discard) a pre-roll up to the window start so stateful DSP
    // and the content before the window (sustained clips, sidechain keys)
    // are already in motion when capture begins. Renders from the timeline
    // start have nothing before them and start cold by definition.
    const prerollFrames = Math.min(startSample, Math.round(prerollSeconds * sampleRate));
    const captureOffset = capturePreroll ? prerollFrames : 0;
    const left = onChunk ? null : new Float32Array(totalFrames + captureOffset);
    const right = onChunk ? null : new Float32Array(totalFrames + captureOffset);
    const windowStart = startSample - prerollFrames;
    engine.seekSample(windowStart);
    // The priming block runs stopped, so no clip audio is read yet; the pages
    // only have to be in place before the first block that plays.
    engine.process([new Float32Array(RENDER_BLOCK_FRAMES), new Float32Array(RENDER_BLOCK_FRAMES)]);
    engine.settleParameters();
    engine.play();
    let prerollDone = 0;
    while (prerollDone < prerollFrames) {
      const blockFrames = Math.min(RENDER_BLOCK_FRAMES, prerollFrames - prerollDone);
      await streams?.advance(windowStart + prerollDone, blockFrames);
      const out = engine.process([new Float32Array(blockFrames), new Float32Array(blockFrames)]);
      if (capturePreroll && left && right) {
        left.set(out[0].subarray(0, blockFrames), prerollDone);
        right.set((out[1] ?? out[0]).subarray(0, blockFrames), prerollDone);
      }
      prerollDone += blockFrames;
    }
    let framesDone = 0;
    let blocksSinceCheckpoint = 0;
    while (framesDone < totalFrames) {
      const blockFrames = Math.min(RENDER_BLOCK_FRAMES, totalFrames - framesDone);
      await streams?.advance(startSample + framesDone, blockFrames);
      const out = engine.process([new Float32Array(blockFrames), new Float32Array(blockFrames)]);
      if (onChunk) {
        // process() may reuse its output storage on the next block; each
        // consumer receives ownership of a compact transferable copy.
        await onChunk(
          [out[0].slice(0, blockFrames), (out[1] ?? out[0]).slice(0, blockFrames)],
          framesDone,
        );
      } else {
        left!.set(out[0].subarray(0, blockFrames), captureOffset + framesDone);
        right!.set((out[1] ?? out[0]).subarray(0, blockFrames), captureOffset + framesDone);
      }
      framesDone += blockFrames;
      if (++blocksSinceCheckpoint >= BLOCKS_PER_CHECKPOINT) {
        blocksSinceCheckpoint = 0;
        checkCancel();
        options.onProgress?.(
          progressStart + (framesDone / Math.max(1, totalFrames)) * progressSpan,
          stage,
        );
        if (options.yieldBetweenBlocks) await options.yieldBetweenBlocks();
      }
    }
    engine.stop();
    return [left ?? new Float32Array(0), right ?? new Float32Array(0)];
  };

  /** Runs one configured pass on a fresh engine, destroying it afterwards. */
  /** Most warped clips any pass played repitched for want of a stretch voice. */
  let warpOverflows = 0;
  const runPass = async (
    pass: RenderPass,
    stage: string,
    progressStart: number,
    progressSpan: number,
    capturePreroll = false,
    onChunk?: (
      channels: readonly [Float32Array, Float32Array],
      offsetFrames: number,
    ) => Promise<void> | void,
  ): Promise<[Float32Array, Float32Array]> => {
    const engine = (createEngine as NonNullable<typeof createEngine>)(
      sampleRate,
      RENDER_BLOCK_FRAMES,
    );
    // Page providers belong to the engine that reads them, so every pass opens
    // (and releases) its own set.
    let streams: AudioClipStreamSession | undefined;
    try {
      if (clipStreamPlans.length > 0 && options.createClipPageStream) {
        streams = await AudioClipStreamSession.open(
          engine,
          clipStreamPlans,
          options.createClipPageStream,
          options.clipStreamResidentBudgetBytes !== undefined
            ? { residentBudgetBytes: options.clipStreamResidentBudgetBytes }
            : {},
        );
      }
      configureEngine(engine, pass, streams?.clipSpecs());
      return await renderWindow(
        engine,
        stage,
        progressStart,
        progressSpan,
        capturePreroll,
        onChunk,
        streams,
      );
    } finally {
      warpOverflows = Math.max(warpOverflows, engine.warpStretchOverflowCount());
      streams?.close();
      engine.destroy();
    }
  };

  // A freeze render is a single isolated pre-fader pass; everything else
  // renders the mix (and optional stems).
  if (freezePass !== null) {
    let channels = await runPass(freezePass, 'engine.freeze', 0, 0.9);
    if (options.releaseTailFromEngine) {
      // The engine tail is an upper bound; drop the appended part that has decayed out.
      const appendedFrames =
        range.endPpq === null || options.appendReleaseTailForExplicitRange
          ? Math.round(Math.max(0, releaseTailSeconds ?? RELEASE_TAIL_SECONDS) * sampleRate)
          : 0;
      channels = trimDecayedTail(channels, Math.max(0, totalFrames - appendedFrames));
    }
    options.onProgress?.(1, 'done');
    let freezePeak = 0;
    for (const channel of channels) {
      for (const value of channel) {
        const magnitude = Math.abs(value);
        if (magnitude > freezePeak) freezePeak = magnitude;
      }
    }
    return {
      channels,
      sampleRate,
      totalFrames: channels[0]?.length ?? 0,
      report: {
        peakDb: peakDb(freezePeak),
      },
    };
  }

  // Pass schedule: the mix, then isolated passes per audible track and,
  // optionally, per declared mixer bus/return.
  const stemPassCount = stemTracks.length + stemBuses.length;
  const sf2PreRenderCount = conflictingSf2TrackIndices.size;
  const passSpan = 0.9 / (1 + stemPassCount + sf2PreRenderCount);
  let passIndex = 0;
  // A plain master pass can be delivered block by block. Do not take this
  // path when any later stage needs the complete waveform (mastering chain,
  // stems, or multi-SF2 pre-renders), as preserving those semantics wins over
  // reducing retained memory.
  if (streamingMixdownEligible) {
    let streamPeak = 0;
    await runPass(
      {
        masterStrip: includeMasterChain,
        masterLevels: true,
        stemIndices: null,
        stemRouting: 'document',
        separateReturnStems: false,
        busStemId: null,
        freezeIndex: null,
        sf2TrackIndices: activeSf2TrackIndices,
        usePreRenderedSf2: false,
      },
      'engine.render',
      0,
      0.9,
      false,
      async (channels, offsetFrames) => {
        for (const channel of channels) {
          for (const value of channel) streamPeak = Math.max(streamPeak, Math.abs(value));
        }
        await options.onMixdownChunk!(channels, offsetFrames, totalFrames);
      },
    );
    const report: MixdownReport = { peakDb: peakDb(streamPeak) };
    const limitations: ExportLimitation[] = [
      ...offlineAutomationLimitations(doc),
      {
        kind: 'streaming-metering-unavailable',
        measurements: ['lufs', 'true-peak'],
      },
    ];
    if (warpOverflows > 0)
      limitations.push({ kind: 'warp-voices-exceeded', overflows: warpOverflows });
    if (limitations.length > 0) report.limitations = limitations;
    if (mediaIssues.length > 0) report.mediaIssues = mediaIssues;
    options.onProgress?.(1, 'done');
    return {
      channels: [new Float32Array(0), new Float32Array(0)],
      sampleRate,
      totalFrames,
      report,
    };
  }

  if (sf2PreRenderCount > 0) {
    const prerollFrames = Math.min(startSample, Math.round(prerollSeconds * sampleRate));
    const clipStartPpq = samplesToPpq(tempoMap, startSample - prerollFrames, sampleRate);
    const sf2Clips: EngineClipSpec[] = [];
    for (const trackIndex of conflictingSf2TrackIndices) {
      checkCancel();
      const channels = await runPass(
        {
          masterStrip: false,
          masterLevels: false,
          stemIndices: new Set([trackIndex]),
          stemRouting: 'document',
          separateReturnStems: false,
          busStemId: null,
          freezeIndex: trackIndex,
          sf2TrackIndices: new Set([trackIndex]),
          usePreRenderedSf2: false,
        },
        `engine.sf2:${trackIndex}`,
        passSpan * passIndex,
        passSpan,
        true,
      );
      passIndex += 1;
      sf2Clips.push({
        trackId: trackIds[trackIndex],
        channels,
        startPpq: clipStartPpq,
        lengthSamples: channels[0].length,
        gain: 1,
      });
    }
    renderAudioClips = [...sourceAudioClips, ...sf2Clips];
  }

  let [mixL, mixR] = await runPass(
    {
      masterStrip: includeMasterChain,
      masterLevels: true,
      stemIndices: null,
      stemRouting: 'document',
      separateReturnStems: false,
      busStemId: null,
      freezeIndex: null,
      sf2TrackIndices: sf2PreRenderCount > 0 ? new Set() : activeSf2TrackIndices,
      usePreRenderedSf2: sf2PreRenderCount > 0,
    },
    'engine.render',
    passSpan * passIndex,
    passSpan,
  );
  passIndex += 1;

  const stems: MixdownStem[] = [];
  let emittedStemCount = 0;
  const consumeStem = async (stem: MixdownStem): Promise<void> => {
    if (options.onStem) {
      await options.onStem(stem, emittedStemCount, stemCount);
    } else {
      stems.push(stem);
    }
    emittedStemCount += 1;
    checkCancel();
  };
  for (let i = 0; i < stemTracks.length; i++) {
    const { track, trackIndex } = stemTracks[i];
    checkCancel();
    // A group stem keeps its member lanes audible (their output routes
    // through the group bus), so it renders the group submix.
    const stemIndices = new Set<number>([trackIndex]);
    if (track.kind === 'group') {
      doc.tracks.forEach((member, memberIndex) => {
        if (member.groupIndex === trackIndex && audibleTrackIndices.has(memberIndex)) {
          stemIndices.add(memberIndex);
        }
      });
    }
    const channels = await runPass(
      {
        masterStrip: false,
        masterLevels: false,
        stemIndices,
        stemRouting:
          track.kind === 'group'
            ? 'group'
            : options.busStems === true || track.mixer?.outputBusId === undefined
              ? 'direct'
              : 'document',
        separateReturnStems: options.busStems === true,
        busStemId: null,
        freezeIndex: null,
        sf2TrackIndices: sf2PreRenderCount > 0 ? new Set() : activeSf2TrackIndices,
        usePreRenderedSf2: sf2PreRenderCount > 0,
      },
      `engine.stem:${trackIndex}`,
      passSpan * passIndex,
      passSpan,
    );
    passIndex += 1;
    await consumeStem({
      source: 'track',
      trackIndex,
      name: track.name,
      channels,
      report: buildReport(
        channels[0],
        channels[1],
        sampleRate,
        totalFrames,
        deps?.metering ?? null,
      ),
    });
  }
  for (let i = 0; i < stemBuses.length; i++) {
    const { bus, busIndex, busNumber } = stemBuses[i];
    checkCancel();
    const channels = await runPass(
      {
        masterStrip: false,
        masterLevels: false,
        stemIndices: null,
        stemRouting: 'document',
        separateReturnStems: false,
        busStemId: busNumber,
        freezeIndex: null,
        sf2TrackIndices: sf2PreRenderCount > 0 ? new Set() : activeSf2TrackIndices,
        usePreRenderedSf2: sf2PreRenderCount > 0,
      },
      `engine.busStem:${busIndex}`,
      passSpan * passIndex,
      passSpan,
    );
    passIndex += 1;
    await consumeStem({
      source: 'bus',
      trackIndex: -1 - busIndex,
      busId: bus.id,
      busIndex,
      name: `${bus.name} Return`,
      channels,
      report: buildReport(
        channels[0],
        channels[1],
        sampleRate,
        totalFrames,
        deps?.metering ?? null,
      ),
    });
  }

  // Mastering chain: export-only stage on the bounced stereo. Stages run in
  // declared order; an automated stage the engine can drive runs as a strip
  // insert in its own pass so its lanes are actually time-varying, everything
  // else keeps the whole-buffer call it has always used.
  let masteringFrozenParams: string[] | undefined;
  let presetLoudnessLimit: ExportLimitation | undefined;
  if (includeMasterChain && chain && masteringChainIsActive(chain) && mastering) {
    // The plan was computed during preflight, before the render buffers were
    // created. It is non-null under the same condition as this branch.
    const plan = masteringPlan;
    if (!plan) throw new Error('Mastering stage plan was not prepared');
    masteringFrozenParams = plan.frozenParams;
    if (chain.preset !== undefined && mastering.applyPreset) {
      checkCancel();
      options.onProgress?.(0.92, `mastering.preset:${chain.preset}`);
      const out = mastering.applyPreset(
        chain.preset,
        mixL,
        mixR,
        sampleRate,
        chain.presetOverrides,
      );
      mixL = out.left;
      mixR = out.right;
      if (out.loudnessTargetLimited === true && Number.isFinite(out.outputLufs)) {
        presetLoudnessLimit = {
          kind: 'mastering-loudness-target-limited',
          outputLufs: out.outputLufs as number,
        };
      }
    }
    for (const stage of plan.stages) {
      checkCancel();
      if (stage.kind === 'whole-buffer') {
        options.onProgress?.(0.94, `mastering.${stage.processor}`);
        const out = mastering.processStereo(stage.processor, mixL, mixR, sampleRate, stage.params);
        mixL = out.left;
        mixR = out.right;
        continue;
      }
      options.onProgress?.(0.94, `mastering.automated:${stage.slots[0].processor}`);
      const out = await runMasteringEnginePass(stage, mixL, mixR, {
        createEngine,
        sampleRate,
        startSample,
        startPpq: range.startPpq,
        tempoSegments,
        checkCancel,
        yieldBetweenBlocks: options.yieldBetweenBlocks,
      });
      mixL = out.left;
      mixR = out.right;
    }
  }

  // Loudness/peak report (same shape as renderMixdown).
  checkCancel();
  options.onProgress?.(0.97, 'metering');
  const report: MixdownReport = buildReport(
    mixL,
    mixR,
    sampleRate,
    totalFrames,
    deps?.metering ?? null,
  );
  const limitations = offlineAutomationLimitations(doc, masteringFrozenParams);
  if (presetLoudnessLimit) limitations.push(presetLoudnessLimit);
  if (warpOverflows > 0)
    limitations.push({ kind: 'warp-voices-exceeded', overflows: warpOverflows });
  if (limitations.length > 0) report.limitations = limitations;
  if (mediaIssues.length > 0) report.mediaIssues = mediaIssues;

  if (options.stems && options.masterStem === true) {
    await consumeStem({
      source: 'master',
      trackIndex: Number.MIN_SAFE_INTEGER,
      name: 'Master',
      channels: [new Float32Array(mixL), new Float32Array(mixR)],
      report: { ...report },
    });
  }
  options.onProgress?.(1, 'done');

  const result: MixdownResult = { channels: [mixL, mixR], sampleRate, totalFrames, report };
  if (options.stems && !options.onStem) result.stems = stems;
  return result;
}

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
} from '@/engine/engine-declaration';
import { resolvePresetName } from '@/engine/instruments';
import { PFL_AUDITION_GAIN_DB } from '@/engine/mixer-sync';
import { busSceneJson, stripSceneJson } from '@/engine/strip-sync';
import { activeTimeEffectSlots, suggestedTailSeconds } from '@/export/audio-preflight';
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
  evaluateAutomationValue,
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
import { effectiveTrackInstrument, sf2PlaybackConfig } from '@/project/instrument';
import { midiFxConfigJson } from '@/project/midi-fx';
import {
  clampPan,
  DEFAULT_PAN_LAW,
  DEFAULT_PAN_MODE,
  effectiveTrackMute,
  laneGainDb,
  masteringChainIsActive,
  normalizeMixerSoloMode,
  returnSoloRouting,
  stripHasDsp,
  tracksWithVcaSolo,
  vcaOffsetDb,
} from '@/project/mixer';
import { expandedSoloStates } from '@/project/scheduling';
import type { ProjectDocument } from '@/project/serialization';
import {
  collectActiveSoundFontUsage,
  hasSoundFontSlotConflict,
} from '@/project/soundfont-conflicts';
import { normalizeTempoMap, ppqToSamples, samplesToPpq } from '@/project/tempo-map';
import { buildAudioClips, preflightAudioClipMemory } from './engine-render-clips';
import {
  activeMidiTrackIndicesForRange,
  buildBusRouting,
  buildMidiSchedules,
  documentAudibleTrackIndices,
  preloadSoundFonts,
  resolveRenderWindow,
} from './engine-render-context';
import { buildReport } from './engine-render-report';
import {
  BLOCKS_PER_CHECKPOINT,
  busParamId,
  DEFAULT_TEMPO_BPM,
  ENGINE_MIXER_PARAM_FADER_DB,
  ENGINE_MIXER_PARAM_PAN,
  type EngineClipSpec,
  type EngineRenderOptions,
  laneParamId,
  MAX_PREROLL_SECONDS,
  masterParamId,
  type OfflineRenderEngine,
  PREROLL_SECONDS,
  RENDER_BLOCK_FRAMES,
  type RenderPass,
  resolveRange,
} from './engine-render-types';

export type { EngineRenderOptions, OfflineRenderEngine } from './engine-render-types';

function instrumentPatchAtRenderStart(
  track: ProjectDocument['tracks'][number],
  ppq: number,
): Record<string, unknown> | null {
  if (track.instrument?.kind !== 'synth-patch') return null;
  const patch: Record<string, unknown> = { ...track.instrument.patch };
  for (const lane of track.automation ?? []) {
    if (!lane.enabled || lane.points.length === 0) continue;
    const ref = parseInstrumentAutomationParam(lane.param);
    if (!ref) continue;
    const points = sanitizeAutomationPoints(lane.param, lane.points);
    if (points.length === 0) continue;
    patch[ref.paramName] = evaluateAutomationValue(points, ppq);
  }
  return patch;
}

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
  const instrumentTrackNames = doc.tracks
    .filter((track) => track.instrument?.kind === 'synth-patch')
    .filter((track) =>
      (track.automation ?? []).some((lane) => {
        if (!lane.enabled || !parseInstrumentAutomationParam(lane.param)) return false;
        return hasTimeVaryingPoints(sanitizeAutomationPoints(lane.param, lane.points));
      }),
    )
    .map((track) => track.name);
  if (instrumentTrackNames.length > 0) {
    limitations.push({
      kind: 'instrument-automation-at-render-start',
      tracks: instrumentTrackNames,
    });
  }
  return limitations;
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
  doc: ProjectDocument,
  options: EngineRenderOptions = {},
): Promise<MixdownResult> {
  const sampleRate = options.sampleRate ?? doc.sampleRate;
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new RangeError(`Render sample rate must be finite and > 0, got ${sampleRate}`);
  }
  const includeMasterChain = options.includeMasterChain ?? true;
  const loadAudio = options.loadAudioAsset ?? loadAsset;
  const loadAudioMeta =
    options.loadAudioAssetMeta ?? (options.loadAudioAsset === undefined ? loadAssetMeta : null);
  const loadFontBytes = options.loadFont ?? loadFont;
  let resolvePreset = options.resolvePreset ?? ((preset: string) => preset);
  let resolveInsertLatency: InsertLatencyResolver = options.insertLatency ?? (() => 0);
  const checkCancel = () => {
    if (options.shouldCancel?.()) throw new MixdownCancelledError();
  };

  const tempoSegments =
    doc.tempoSegments.length > 0 ? doc.tempoSegments : [{ startPpq: 0, bpm: DEFAULT_TEMPO_BPM }];
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
        masteringProcessorCatalog?: () => Array<InsertLatencyCatalogEntry & MasteringCatalogEntry>;
      }
    ).masteringProcessorCatalog?.();
    if (!options.insertLatency) {
      resolveInsertLatency = insertLatencyResolverFromCatalog(catalog, { sampleRate });
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
  const { vcaGainDbById, vcaControlsById, busNumberById, buses, groupBusByTrackIndex, lanes } =
    buildBusRouting(doc, trackIds);
  const tracksForSolo = tracksWithVcaSolo(doc.tracks, vcaControlsById);
  const documentSoloExpansion = {
    isGroup: (track: ProjectDocument['tracks'][number]) => track.kind === 'group',
    groupKey: (_track: ProjectDocument['tracks'][number], index: number) => index,
    memberGroupKey: (track: ProjectDocument['tracks'][number]) => track.groupIndex,
  };
  const audibleTrackIndices = documentAudibleTrackIndices(doc);
  if (options.freezeTrackIndex !== undefined) audibleTrackIndices.add(options.freezeTrackIndex);
  const prerollSeconds = Math.min(
    MAX_PREROLL_SECONDS,
    Math.max(
      PREROLL_SECONDS,
      suggestedTailSeconds(
        activeTimeEffectSlots(doc, audibleTrackIndices, {
          includeMaster: includeMasterChain,
          includeMastering: includeMasterChain,
        }),
      ),
    ),
  );
  // The capture range remains the user-selected window. Audio scheduling and
  // metadata preflight additionally cover exactly the stateful-DSP preroll
  // which is rendered and discarded before capture begins.
  const renderStartSample = ppqToSamples(tempoMap, range.startPpq, sampleRate);
  const prerollFrames = Math.min(renderStartSample, Math.round(prerollSeconds * sampleRate));
  const contributionRange = {
    startPpq: samplesToPpq(tempoMap, renderStartSample - prerollFrames, sampleRate),
    endPpq: range.endPpq,
  };

  // Build the MIDI program before loading any SoundFont. Exact compiled note
  // intervals plus the shared audible/range plan determine which fonts can
  // actually contribute to this render.
  const midiSchedules = buildMidiSchedules(doc, trackIds, tempoSegments, sampleRate);
  const midiRangeStartSample = renderStartSample - prerollFrames;
  const midiRangeEndSample =
    range.endPpq === null
      ? Number.POSITIVE_INFINITY
      : ppqToSamples(tempoMap, range.endPpq, sampleRate);
  const activeMidiTrackIndices = activeMidiTrackIndicesForRange(
    midiSchedules,
    trackIds,
    audibleTrackIndices,
    midiRangeStartSample,
    midiRangeEndSample,
  );
  const effectiveInstruments = doc.tracks.map((track) =>
    track.kind === 'midi' ? effectiveTrackInstrument(track, doc.externalMidiDefault) : undefined,
  );
  const soundFontUsage = collectActiveSoundFontUsage(
    doc.tracks
      .map((track, index) => ({ ...track, instrument: effectiveInstruments[index] }))
      .filter((_track, index) => activeMidiTrackIndices.has(index)),
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
  const stemCount =
    stemTracks.length + stemBuses.length + (options.stems && options.masterStem === true ? 1 : 0);
  const chain = doc.mixer?.masteringChain;
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
          audibleTrackIndices,
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
        audibleTrackIndices,
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
    audibleTrackIndices,
    options.appendReleaseTailForExplicitRange,
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
      }),
      options.memoryBudgetBytes,
    );
  }

  const mediaIssues: NonNullable<MixdownReport['mediaIssues']> = [];
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
    audibleTrackIndices,
    streamedKeys,
  });

  // Resolve the render window in frames. Paged clips carry no buffer, so the
  // window has to hear about them through their planned length.
  const { startSample, totalFrames } = resolveRenderWindow(
    doc,
    tempoMap,
    range,
    sampleRate,
    options.releaseTailSeconds,
    [
      ...sourceAudioClips,
      ...clipStreamPlans.map((plan) => ({
        startPpq: plan.startPpq,
        lengthSamples: plan.frameCount,
      })),
    ],
    audibleTrackIndices,
    options.appendReleaseTailForExplicitRange,
  );
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
  ): void => {
    const supportsBusEq = typeof engine.setBusStripEqBandJson === 'function';
    const supportsBusInsertBypass = typeof engine.setBusStripInsertBypassed === 'function';
    // The engine validates sends against already-declared buses, so the bus
    // set must be installed before any lane that carries sends. A freeze pass
    // strips the frozen lane's sends (they stay live on the track). A bus stem
    // pass adds a silent discard bus so non-selected direct outputs can be
    // removed while selected sends/outputs still feed the return.
    const silentBusId =
      pass.busStemId === null ? null : buses.reduce((max, bus) => Math.max(max, bus.busId), 0) + 1;
    const passBuses =
      silentBusId === null ? buses : [...buses, { busId: silentBusId, gainDb: -120 }];
    if (passBuses.length > 0) engine.setTrackBuses(passBuses);
    const passLanes =
      pass.freezeIndex !== null
        ? lanes.map((lane, index) =>
            index === pass.freezeIndex ? { trackId: lane.trackId } : lane,
          )
        : pass.busStemId !== null && silentBusId !== null
          ? lanes.map((lane) => {
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
            ? lanes.map((lane, index) => {
                if (!pass.stemIndices?.has(index)) return lane;
                return {
                  trackId: lane.trackId,
                  ...(!pass.separateReturnStems && lane.sends?.length ? { sends: lane.sends } : {}),
                  ...(pass.stemRouting === 'group' && lane.outputBusId !== undefined
                    ? { outputBusId: lane.outputBusId }
                    : {}),
                };
              })
            : lanes;
    engine.setTrackLanes(passLanes);

    for (const bus of doc.mixer?.buses ?? []) {
      const busId = busNumberById.get(bus.id);
      if (busId === undefined) continue;
      if (!engineBusStripHasDsp(bus.strip, supportsBusEq)) continue;
      const engineStrip = supportsBusInsertBypass ? bus.strip : engineBusStrip(bus.strip);
      engine.setBusStripJson(
        busId,
        busSceneJson(busId, engineStrip, undefined, { includeEq: supportsBusEq }),
      );
      if (supportsBusInsertBypass) {
        bus.strip?.inserts.forEach((slot, insertIndex) => {
          if (!slot.enabled) engine.setBusStripInsertBypassed?.(busId, insertIndex, true);
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
    const auditionSoloStates =
      normalizeMixerSoloMode(doc.mixer?.soloMode) === 'pfl'
        ? expandedSoloStates(
            tracksForSolo.map((track) => ({ ...track, soloSafe: false })),
            documentSoloExpansion,
          )
        : [];
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
              if (!slot.enabled) engine.setBusStripInsertBypassed?.(busId, insertIndex, true);
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
      if (track.frozen === undefined && !usesPreRenderedSf2 && strip && stripHasDsp(strip)) {
        // Frozen tracks bypass their strip DSP (baked into the render).
        engine.setTrackStripJson(trackId, stripSceneJson(trackId, strip));
        strip.inserts.forEach((slot, insertIndex) => {
          if (!slot.enabled) engine.setTrackStripInsertBypassed(trackId, insertIndex, true);
        });
        engineEqBands(strip).forEach((band, bandIndex) => {
          engine.setTrackStripEqBandJson(trackId, bandIndex, JSON.stringify(band));
        });
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
        engine.setParameter(laneParamId(index, ENGINE_MIXER_PARAM_FADER_DB), 0);
        engine.setParameter(laneParamId(index, ENGINE_MIXER_PARAM_PAN), 0);
      } else {
        const pflAudition = pass.stemIndices === null && auditionSoloStates[index] === true;
        // Lane fader includes the strip trim and the track's VCA group offset,
        // so a VCA-attenuated track exports at the level it plays back at.
        engine.setParameter(
          laneParamId(index, ENGINE_MIXER_PARAM_FADER_DB),
          pflAudition
            ? PFL_AUDITION_GAIN_DB
            : laneGainDb(track.volume, strip?.gainDb, vcaOffsetDb(track.vcaId, vcaGainDbById)),
        );
        // MixerStrip.pan is canonical. Fall back to DocumentTrack.pan so
        // pre-migration projects and freshly imported foreign documents pan
        // identically before and after a save/load cycle.
        const pan = pflAudition ? 0 : clampPan(strip?.pan ?? track.pan ?? 0);
        engine.setParameter(laneParamId(index, ENGINE_MIXER_PARAM_PAN), pan);
        // Pan law / mode / dual-pan / channel-delay shape the lane exactly as
        // live mixer-sync does; emit only the non-defaults to keep the command
        // budget small (the engine starts each lane at these defaults).
        const panLaw = strip?.panLaw ?? DEFAULT_PAN_LAW;
        if (panLaw !== DEFAULT_PAN_LAW) engine.setTrackStripPanLaw(trackId, panLaw);
        const panMode = strip?.panMode ?? DEFAULT_PAN_MODE;
        if (panMode !== DEFAULT_PAN_MODE) engine.setTrackStripPanMode(trackId, panMode);
        if (pflAudition) {
          engine.setTrackStripDualPan(trackId, 0, 0);
        } else if (strip?.dualPan) {
          engine.setTrackStripDualPan(
            trackId,
            clampPan(strip.dualPan.left),
            clampPan(strip.dualPan.right),
          );
        }
        // The pre-rendered SF2 PCM contains the insert processor's own
        // latency, but not the live PDC channel delay (freeze passes keep it
        // outside the bake), so the final lane still receives normal PDC.
        const channelDelay = pdc.delayFor(pdcTracks[index]);
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

    // Master strip: inserts/EQ only with the chain enabled; gain/pan whenever
    // the pass renders master levels (stems are pre-master).
    const master = doc.mixer?.master;
    // `liveMasterStrip` is strictly a preview optimization. Offline export
    // keeps the master strip independent, then applies the entire mastering
    // rack after its preset in declared order below.
    const masterStrip = master;
    if (pass.masterStrip && masterStrip && stripHasDsp(masterStrip)) {
      engine.setMasterStripJson(stripSceneJson('master', masterStrip));
      masterStrip.inserts.forEach((slot, insertIndex) => {
        if (!slot.enabled) engine.setMasterStripInsertBypassed(insertIndex, true);
      });
      engineEqBands(masterStrip).forEach((band, bandIndex) => {
        engine.setMasterStripEqBandJson(bandIndex, JSON.stringify(band));
      });
    }
    if (pass.masterLevels) {
      engine.setParameter(masterParamId(ENGINE_MIXER_PARAM_FADER_DB), master?.gainDb ?? 0);
      engine.setParameter(masterParamId(ENGINE_MIXER_PARAM_PAN), clampPan(master?.pan ?? 0));
    }

    // Automation lanes (track entries + master), enabled lanes only.
    doc.tracks.forEach((track, index) => {
      const usesPreRenderedSf2 = pass.usePreRenderedSf2 && conflictingSf2TrackIndices.has(index);
      for (const lane of track.automation ?? []) {
        if (!lane.enabled || lane.points.length === 0) continue;
        const pflAudition = pass.stemIndices === null && auditionSoloStates[index] === true;
        if (
          (pass.freezeIndex === index || pflAudition) &&
          (lane.param === 'faderDb' || lane.param === 'pan')
        ) {
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
            engine.setAutomationLane(busParamId(groupBusId), points);
          }
          continue;
        }
        const kind = lane.param === 'pan' ? ENGINE_MIXER_PARAM_PAN : ENGINE_MIXER_PARAM_FADER_DB;
        engine.setAutomationLane(laneParamId(index, kind), points);
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
        const kind = lane.param === 'pan' ? ENGINE_MIXER_PARAM_PAN : ENGINE_MIXER_PARAM_FADER_DB;
        engine.setAutomationLane(masterParamId(kind), points);
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
        engine.setAutomationLane(busParamId(busId), points);
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
    for (let index = 0; index < doc.tracks.length; index++) {
      const track = doc.tracks[index];
      if (track.kind !== 'midi') continue;
      if (track.frozen !== undefined) continue;
      const instrument = effectiveInstruments[index];
      const destinationId = trackIds[index];
      if (instrument?.kind === 'synth-preset') {
        engine.setSynthInstrument(resolvePreset(instrument.preset), destinationId);
      } else if (instrument?.kind === 'synth-patch') {
        engine.setSynthInstrument(
          instrumentPatchAtRenderStart(track, range.startPpq) ?? instrument.patch,
          destinationId,
        );
      } else if (instrument?.kind === 'sf2') {
        if (pass.sf2TrackIndices !== null && !pass.sf2TrackIndices.has(index)) continue;
        const bytes = fontBytesById.get(instrument.fontId);
        if (bytes && instrument.fontId !== loadedFontId) {
          engine.loadSoundFont(bytes);
          loadedFontId = instrument.fontId;
        }
        engine.setSf2Instrument(sf2PlaybackConfig(instrument), destinationId);
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
    if (passClips.length > 0) engine.setClips(passClips as EngineClipSpec[]);
  };

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
      streams?.close();
      engine.destroy();
    }
  };

  // A freeze render is a single isolated pre-fader pass; everything else
  // renders the mix (and optional stems).
  if (options.freezeTrackIndex !== undefined) {
    const freezeIndex = options.freezeTrackIndex;
    if (!Number.isInteger(freezeIndex) || freezeIndex < 0 || freezeIndex >= doc.tracks.length) {
      throw new RangeError(`Freeze track index ${freezeIndex} is out of range`);
    }
    if (doc.tracks[freezeIndex].kind === 'group') {
      throw new RangeError('Group tracks cannot be frozen');
    }
    const channels = await runPass(
      {
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
      },
      'engine.freeze',
      0,
      0.9,
    );
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
      totalFrames,
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
  const mastering = deps?.mastering ?? null;

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
  if (includeMasterChain && chain && masteringChainIsActive(chain) && mastering) {
    const plan = planMasteringStages(
      chain,
      doc.masterAutomation ?? [],
      range.startPpq,
      masteringCapability,
    );
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

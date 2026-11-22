import type {
  EqBandInput,
  MixSceneBusInput,
  MixSceneInsert,
  MixSceneStripInput,
} from '@libraz/libsonare';
import {
  DEFAULT_SURROUND_PAN,
  type MasteringChainState,
  type MixerChannelLayout,
  type MixerStrip,
} from '@/project/mixer';
import {
  ENGINE_DEFAULT_PAN_LAW,
  ENGINE_DEFAULT_PAN_MODE,
  engineBusPanState,
  engineEqBands,
} from './engine-declaration';

export interface BusSceneOptions {
  /** Include bus EQ metadata for engines that expose the bus-EQ ABI. */
  includeEq?: boolean;
  /** Channel layout of the bus; absent keeps the stereo default. */
  channelLayout?: MixerChannelLayout;
}

/**
 * Builds the scene declaring one BUS strip's insert chain (group tracks;
 * exported for tests). Mirrors {@link stripScene} but yields the bus
 * entry that setBusStrip consumes.
 */
export function busScene(
  busId: number,
  strip: MixerStrip | undefined,
  insertCatalog?: ReadonlySet<string> | null,
  options: BusSceneOptions = {},
): MixSceneBusInput {
  const inserts = (strip?.inserts ?? []).map((slot) => {
    if (insertCatalog && !insertCatalog.has(slot.processor)) {
      throw new Error(`Unsupported insert processor: ${slot.processor}`);
    }
    return { slot: 'pre', processor: slot.processor, params: { ...slot.params } } as MixSceneInsert;
  });
  // The bus carries the same output trim/width/polarity stages a strip exposes;
  // each is emitted only when non-default so an unshaped bus stays byte-identical.
  const bus: MixSceneBusInput = { id: `bus-${busId}`, role: 'submix', inserts };
  const channelLayout = options.channelLayout;
  const surroundBus = channelLayout === '5.1' || channelLayout === '7.1';
  if (channelLayout !== undefined && channelLayout !== 'stereo') {
    bus.layout = channelLayout;
  }
  const inputTrimDb = strip?.inputTrimDb ?? 0;
  if (inputTrimDb !== 0) bus.inputTrimDb = inputTrimDb;
  const width = strip?.width ?? 1;
  if (!surroundBus && width !== 1) bus.width = width;
  if (strip?.polarityInvertLeft === true) bus.polarityInvertLeft = true;
  if (strip?.polarityInvertRight === true) bus.polarityInvertRight = true;
  const pan = engineBusPanState(strip);
  if (!surroundBus) {
    if (pan.pan !== 0) bus.pan = pan.pan;
    if (pan.panMode !== ENGINE_DEFAULT_PAN_MODE) bus.panMode = pan.panMode;
    if (pan.dualPanLeft !== -1) bus.dualPanLeft = pan.dualPanLeft;
    if (pan.dualPanRight !== 1) bus.dualPanRight = pan.dualPanRight;
    if (pan.panLaw !== ENGINE_DEFAULT_PAN_LAW) bus.panLaw = pan.panLaw;
  }
  const eqBands: EqBandInput[] = options.includeEq ? engineEqBands(strip) : [];
  if (eqBands.length > 0) bus.eq = { enabled: true, bands: eqBands };
  return bus;
}

/**
 * Builds the scene declaring one strip's insert chain (exported for tests).
 * Track strips leave faderDb/pan on the mixer lane. The master strip repeats
 * its current fader/pan because replacing the master scene resets those
 * scalars in libsonare. EQ is edited per band after the strip is sent.
 *
 * @param target Track id, or 'master' for the master strip.
 * @param strip Store strip (undefined = neutral, declares an empty strip).
 * @param insertCatalog Known processor names; a non-null catalog rejects
 *   unknown processors instead of silently dropping them.
 * @returns The strip for setStrip.
 */
export function stripScene(
  target: number | 'master',
  strip: MixerStrip | undefined,
  insertCatalog?: ReadonlySet<string> | null,
): MixSceneStripInput {
  const inserts = (strip?.inserts ?? []).map((slot) => {
    if (insertCatalog && !insertCatalog.has(slot.processor)) {
      throw new Error(`Unsupported insert processor: ${slot.processor}`);
    }
    return { slot: 'pre', processor: slot.processor, params: { ...slot.params } } as MixSceneInsert;
  });
  const id = target === 'master' ? 'master' : `track-${target}`;
  const sceneStrip: MixSceneStripInput = { id, inserts };
  if (target === 'master') {
    if ((strip?.gainDb ?? 0) !== 0) sceneStrip.faderDb = strip?.gainDb;
    if ((strip?.pan ?? 0) !== 0) sceneStrip.pan = strip?.pan;
  }
  const inputTrimDb = strip?.inputTrimDb ?? 0;
  if (inputTrimDb !== 0) sceneStrip.inputTrimDb = inputTrimDb;
  const width = strip?.width ?? 1;
  if (width !== 1) sceneStrip.width = width;
  if (strip?.polarityInvertLeft === true) sceneStrip.polarityInvertLeft = true;
  if (strip?.polarityInvertRight === true) sceneStrip.polarityInvertRight = true;
  if (strip?.sourceLayout !== undefined && strip.sourceLayout !== 'stereo') {
    sceneStrip.sourceLayout = strip.sourceLayout;
  }
  const surroundPan = strip?.surroundPan;
  if (
    surroundPan &&
    (surroundPan.azimuth !== DEFAULT_SURROUND_PAN.azimuth ||
      surroundPan.divergence !== DEFAULT_SURROUND_PAN.divergence ||
      surroundPan.lfe !== DEFAULT_SURROUND_PAN.lfe)
  ) {
    sceneStrip.surroundPan = {
      azimuth: surroundPan.azimuth,
      divergence: surroundPan.divergence,
      lfe: surroundPan.lfe,
    };
  }
  if (target === 'master') {
    const panner = engineBusPanState(strip);
    if (panner.panLaw !== ENGINE_DEFAULT_PAN_LAW) sceneStrip.panLaw = panner.panLaw;
    if (panner.panMode !== ENGINE_DEFAULT_PAN_MODE) sceneStrip.panMode = panner.panMode;
    if (panner.dualPanLeft !== -1) sceneStrip.dualPanLeft = panner.dualPanLeft;
    if (panner.dualPanRight !== 1) sceneStrip.dualPanRight = panner.dualPanRight;
  }
  return sceneStrip;
}

/**
 * Live playback has no separate post-master mastering-chain node. Mirror the
 * realtime-safe processor slots by appending them to the master strip scene;
 * the opaque preset and offline-only processors remain export-only.
 */
export function liveMasterStrip(
  master: MixerStrip,
  chain: MasteringChainState | undefined,
  insertCatalog?: ReadonlySet<string> | null,
): MixerStrip {
  const realtimeProcessors = (chain?.processors ?? []).filter(
    (slot) => slot.enabled && (!insertCatalog || insertCatalog.has(slot.processor)),
  );
  if (realtimeProcessors.length === 0) return master;
  return {
    ...master,
    inserts: [
      ...master.inserts,
      ...realtimeProcessors.map((slot) => ({
        processor: slot.processor,
        params: { ...slot.params },
        enabled: true,
      })),
    ],
  };
}

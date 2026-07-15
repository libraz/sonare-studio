import { computed, type Ref, ref } from 'vue';
import { confirmDialog } from '@/composables/useDialogs';
import { dawprojectFilename, exportDawproject } from '@/export/dawproject';
import type { MixdownRangePpq } from '@/export/mixdown';
import { projectFilename } from '@/lib/filename';
import { serializeMusicXml } from '@/notation/musicxml';
import { quantizeToScore } from '@/notation/quantize';
import { parseInsertAutomationParam } from '@/project/automation';
import { insertIndexForAutomationRef } from '@/project/automation-insert';
import {
  DEFAULT_PAN_LAW,
  DEFAULT_PAN_MODE,
  DEFAULT_STRIP_WIDTH,
  type MixerStrip,
} from '@/project/mixer';
import { type ProjectDocument, serializeProject } from '@/project/serialization';
import { useProjectStore } from '@/project/store';
import { timeSignatureAt } from '@/project/time-signature';
import { clipKind } from '@/project/types';
import { formatMessage, useI18n } from '@/ui/i18n';

type RunAction = (action: () => Promise<void>) => Promise<void>;
type DownloadBlobFile = (blob: Blob, filename: string) => void;

const MUSICXML_MIME = 'application/vnd.recordare.musicxml+xml';

export interface ProjectExportOptions {
  closeProjectMenu: () => void;
  downloadBlobFile: DownloadBlobFile;
  loopEnabled: Ref<boolean>;
  loopEndPpq: Ref<number>;
  loopStartPpq: Ref<number>;
  runAction: RunAction;
}

export function useProjectExport(options: ProjectExportOptions) {
  const store = useProjectStore();
  const { t } = useI18n();
  const exportDialogOpen = ref(false);

  const exportLoopRegion = computed<MixdownRangePpq | null>(() =>
    options.loopEnabled.value && options.loopEndPpq.value > options.loopStartPpq.value
      ? { startPpq: options.loopStartPpq.value, endPpq: options.loopEndPpq.value }
      : null,
  );

  function openExportDialog(): void {
    options.closeProjectMenu();
    exportDialogOpen.value = true;
  }

  function dawprojectLossItems(doc: ProjectDocument): string[] {
    const messages = t.value.shell.project.dawprojectLoss.items;
    const hasSidechainKey = (slot: {
      sidechainSourceTrackId?: unknown;
      sidechainSourceIndex?: unknown;
    }): boolean =>
      slot.sidechainSourceTrackId !== undefined || slot.sidechainSourceIndex !== undefined;
    const isSidechainKeyExported = (slot: unknown): boolean => {
      const index = (slot as { sidechainSourceIndex?: unknown }).sidechainSourceIndex;
      return (
        typeof index === 'number' &&
        Number.isInteger(index) &&
        index >= 0 &&
        index < doc.tracks.length
      );
    };
    const isDawprojectColor = (color: string): boolean =>
      /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(color);
    const isAutomationLaneExported = (
      lane: { enabled: boolean; points: readonly unknown[]; param: string },
      strip:
        | { inserts: ReadonlyArray<{ id?: string; params: Record<string, unknown> }> }
        | undefined,
    ): boolean => {
      if (!lane.enabled || lane.points.length === 0) return false;
      if (lane.param === 'faderDb' || lane.param === 'pan') return true;
      const insertRef = parseInsertAutomationParam(lane.param);
      if (!insertRef) return false;
      const insertIndex = strip ? insertIndexForAutomationRef(strip.inserts, insertRef) : undefined;
      const slot = insertIndex === undefined ? undefined : strip?.inserts[insertIndex];
      const param = slot?.params[insertRef.paramName];
      return typeof param === 'number' || typeof param === 'boolean';
    };
    const hasStripEqState = (strip: MixerStrip | undefined): boolean =>
      strip?.eq !== undefined && (strip.eq.enabled || strip.eq.bands.length > 0);
    const hasAdvancedStripState = (strip: MixerStrip | undefined): boolean =>
      strip !== undefined &&
      ((strip.inputTrimDb ?? 0) !== 0 ||
        (strip.width ?? DEFAULT_STRIP_WIDTH) !== DEFAULT_STRIP_WIDTH ||
        strip.polarityInvertLeft === true ||
        strip.polarityInvertRight === true ||
        (strip.channelDelaySamples ?? 0) !== 0 ||
        (strip.panLaw ?? DEFAULT_PAN_LAW) !== DEFAULT_PAN_LAW ||
        (strip.panMode ?? DEFAULT_PAN_MODE) !== DEFAULT_PAN_MODE ||
        strip.dualPan !== undefined);
    let warpedAudioClips = 0;
    let clipGains = 0;
    let missingAudioAssets = 0;
    let audioTakes = 0;
    let compSegments = 0;
    let instrumentTracks = 0;
    let midiFxTracks = 0;
    let trackColors = 0;
    let legacyTrackPans = 0;
    let externalMidiRoutes = doc.externalMidiDefault !== undefined ? 1 : 0;
    const arrangementSections = doc.sections.length;
    const chordSymbols = doc.chords?.length ?? 0;
    const scoreDisplaySettings = doc.score !== undefined ? 1 : 0;
    const midiCcBindings = doc.midiCcBindings?.length ?? 0;
    const mixerSnapshots = doc.mixerSnapshots
      ? Object.values(doc.mixerSnapshots.slots).filter(Boolean).length
      : 0;
    const mixerSoloMode =
      doc.mixer?.soloMode !== undefined && doc.mixer.soloMode !== 'inPlace' ? 1 : 0;
    const masteringChain =
      (doc.mixer?.masteringChain?.preset !== undefined ? 1 : 0) +
      (doc.mixer?.masteringChain?.presetOverrides !== undefined &&
      Object.keys(doc.mixer.masteringChain.presetOverrides).length > 0
        ? 1
        : 0) +
      (doc.mixer?.masteringChain?.processors.length ?? 0);
    let scoreAnnotations = 0;
    let frozenTracks = 0;
    let recordInputChannels = 0;
    let soloSafeTracks = 0;
    let automationLanes = 0;
    let stripEqSettings = 0;
    let stripAdvancedSettings = 0;
    let sidechainKeys = 0;

    for (const track of doc.tracks) {
      if (track.instrument !== undefined) instrumentTracks += 1;
      if (track.midiFx !== undefined) midiFxTracks += 1;
      if (!isDawprojectColor(track.color)) trackColors += 1;
      if (track.pan !== 0) legacyTrackPans += 1;
      if (track.externalMidiMode === 'project') externalMidiRoutes += 1;
      if (track.frozen !== undefined) frozenTracks += 1;
      if (track.recordInputChannel !== undefined) recordInputChannels += 1;
      if (track.soloSafe === true) soloSafeTracks += 1;
      automationLanes += (track.automation ?? []).filter(
        (lane) => !isAutomationLaneExported(lane, track.mixer),
      ).length;
      if (hasStripEqState(track.mixer)) stripEqSettings += 1;
      if (hasAdvancedStripState(track.mixer)) stripAdvancedSettings += 1;
      for (const clip of track.clips) {
        if (clip.gain !== 1) clipGains += 1;
        if (clip.kind === 'audio' && clip.warp?.enabled) warpedAudioClips += 1;
        if (clip.kind === 'audio' && clip.assetId === undefined) missingAudioAssets += 1;
        audioTakes += clip.takes?.length ?? 0;
        compSegments += clip.compSegments?.length ?? 0;
        scoreAnnotations += clip.scoreAnnotations?.length ?? 0;
      }
      for (const slot of track.mixer?.inserts ?? []) {
        if (hasSidechainKey(slot) && !isSidechainKeyExported(slot)) sidechainKeys += 1;
      }
    }
    for (const bus of doc.mixer?.buses ?? []) {
      automationLanes += (bus.automation ?? []).filter(
        (lane) => !isAutomationLaneExported(lane, bus.strip),
      ).length;
      if (hasStripEqState(bus.strip)) stripEqSettings += 1;
      if (hasAdvancedStripState(bus.strip)) stripAdvancedSettings += 1;
      for (const slot of bus.strip?.inserts ?? []) {
        if (hasSidechainKey(slot) && !isSidechainKeyExported(slot)) sidechainKeys += 1;
      }
    }
    if (hasStripEqState(doc.mixer?.master)) stripEqSettings += 1;
    if (hasAdvancedStripState(doc.mixer?.master)) stripAdvancedSettings += 1;
    automationLanes += (doc.masterAutomation ?? []).filter(
      (lane) => !isAutomationLaneExported(lane, doc.mixer?.master),
    ).length;
    for (const slot of doc.mixer?.master.inserts ?? []) {
      if (hasSidechainKey(slot) && !isSidechainKeyExported(slot)) sidechainKeys += 1;
    }

    return [
      ...(warpedAudioClips > 0
        ? [formatMessage(messages.warpedAudioClips, { count: warpedAudioClips })]
        : []),
      ...(clipGains > 0 ? [formatMessage(messages.clipGains, { count: clipGains })] : []),
      ...(missingAudioAssets > 0
        ? [formatMessage(messages.missingAudioAssets, { count: missingAudioAssets })]
        : []),
      ...(audioTakes > 0 ? [formatMessage(messages.audioTakes, { count: audioTakes })] : []),
      ...(compSegments > 0 ? [formatMessage(messages.compSegments, { count: compSegments })] : []),
      ...(instrumentTracks > 0
        ? [formatMessage(messages.instrumentTracks, { count: instrumentTracks })]
        : []),
      ...(midiFxTracks > 0 ? [formatMessage(messages.midiFxTracks, { count: midiFxTracks })] : []),
      ...(trackColors > 0 ? [formatMessage(messages.trackColors, { count: trackColors })] : []),
      ...(legacyTrackPans > 0
        ? [formatMessage(messages.legacyTrackPans, { count: legacyTrackPans })]
        : []),
      ...(externalMidiRoutes > 0
        ? [formatMessage(messages.externalMidiRoutes, { count: externalMidiRoutes })]
        : []),
      ...(arrangementSections > 0
        ? [formatMessage(messages.arrangementSections, { count: arrangementSections })]
        : []),
      ...(chordSymbols > 0 ? [formatMessage(messages.chordSymbols, { count: chordSymbols })] : []),
      ...(scoreDisplaySettings > 0
        ? [formatMessage(messages.scoreDisplaySettings, { count: scoreDisplaySettings })]
        : []),
      ...(midiCcBindings > 0
        ? [formatMessage(messages.midiCcBindings, { count: midiCcBindings })]
        : []),
      ...(mixerSnapshots > 0
        ? [formatMessage(messages.mixerSnapshots, { count: mixerSnapshots })]
        : []),
      ...(mixerSoloMode > 0
        ? [formatMessage(messages.mixerSoloMode, { count: mixerSoloMode })]
        : []),
      ...(masteringChain > 0
        ? [formatMessage(messages.masteringChain, { count: masteringChain })]
        : []),
      ...(scoreAnnotations > 0
        ? [formatMessage(messages.scoreAnnotations, { count: scoreAnnotations })]
        : []),
      ...(frozenTracks > 0 ? [formatMessage(messages.frozenTracks, { count: frozenTracks })] : []),
      ...(recordInputChannels > 0
        ? [formatMessage(messages.recordInputChannels, { count: recordInputChannels })]
        : []),
      ...(soloSafeTracks > 0
        ? [formatMessage(messages.soloSafeTracks, { count: soloSafeTracks })]
        : []),
      ...(automationLanes > 0
        ? [formatMessage(messages.automationLanes, { count: automationLanes })]
        : []),
      ...(stripEqSettings > 0
        ? [formatMessage(messages.stripEqSettings, { count: stripEqSettings })]
        : []),
      ...(stripAdvancedSettings > 0
        ? [formatMessage(messages.stripAdvancedSettings, { count: stripAdvancedSettings })]
        : []),
      ...(sidechainKeys > 0
        ? [formatMessage(messages.sidechainKeys, { count: sidechainKeys })]
        : []),
    ];
  }

  function exportDawprojectAction(): void {
    options.closeProjectMenu();
    void options.runAction(async () => {
      const doc = serializeProject();
      const lossItems = dawprojectLossItems(doc);
      if (lossItems.length > 0) {
        const ok = await confirmDialog({
          title: t.value.shell.project.dawprojectLoss.title,
          message: formatMessage(t.value.shell.project.dawprojectLoss.message, {
            items: lossItems.map((item) => `- ${item}`).join('\n'),
          }),
          confirmLabel: t.value.shell.project.dawprojectLoss.confirm,
        });
        if (!ok) return;
      }
      const bytes = await exportDawproject(doc, { includeAudio: true });
      options.downloadBlobFile(
        new Blob([new Uint8Array(bytes)], { type: 'application/zip' }),
        dawprojectFilename(store.projectName),
      );
    });
  }

  function exportMusicXmlAction(): void {
    options.closeProjectMenu();
    void options.runAction(async () => {
      const clip = store.activeClip;
      if (!clip || clipKind(clip) !== 'midi' || store.clipLengthPpq <= 0) return;
      const meter = timeSignatureAt(store.timeSignatures, store.clipStartPpq);
      const score = quantizeToScore(store.notes, {
        divisionPpq: 0.25,
        timeSig: { beats: meter.numerator, beatUnit: meter.denominator },
        keyFifths: 0,
        clipStartPpq: store.clipStartPpq,
        clipLengthPpq: store.clipLengthPpq,
        timeSignatures: store.timeSignatures,
        clef: 'grand',
        partName: store.activeTrack?.name ?? 'Piano',
        displayTransposeSemitones: store.displayTransposeSemitones,
      });
      const title = store.projectName.trim();
      if (title) score.metadata = { title };
      options.downloadBlobFile(
        new Blob([serializeMusicXml(score)], { type: MUSICXML_MIME }),
        projectFilename(store.projectName, '.musicxml', 'score'),
      );
    });
  }

  return {
    exportDialogOpen,
    exportLoopRegion,
    exportDawprojectAction,
    exportMusicXmlAction,
    openExportDialog,
  };
}

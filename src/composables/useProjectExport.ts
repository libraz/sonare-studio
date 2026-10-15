import { computed, type Ref, ref } from 'vue';
import { keyFifthsForScaleHighlight } from '@/components/lists/key-modes';
import { confirmDialog } from '@/composables/useDialogs';
import { confirmLossReport } from '@/composables/useLossConfirm';
import { dawprojectFilename, exportDawprojectWithReport } from '@/export/dawproject';
import { inspectDawprojectExportLoss } from '@/export/dawproject/export-loss';
import type { MixdownRangePpq } from '@/export/mixdown';
import { projectFilename } from '@/lib/filename';
import { inspectMusicXmlExportLoss, serializeMusicXml } from '@/notation/musicxml';
import { scoreClipWindow } from '@/notation/score-clip-window';
import { SCORE_DISPLAY_QUANTIZE_DIVISION_PPQ } from '@/project/annotations';
import { formatMediaCompletenessReport } from '@/project/media-completeness';
import { type ProjectDocument, serializeProject } from '@/project/serialization';
import { useProjectStore } from '@/project/store';
import { formatMessage, useI18n } from '@/ui/i18n';
import {
  scoreExportAvailability as resolveScoreExportAvailability,
  type ScoreExportAvailability,
} from '@/ui/score/export-availability';
import { buildProjectScore } from '@/ui/score/use-score-notation';

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

  const musicXmlAvailability = computed<ScoreExportAvailability>(() =>
    resolveScoreExportAvailability({
      fullScoreEnabled: store.scoreDisplaySettings.fullScoreEnabled,
      activeClip: store.activeClip,
      hasMidiTrack: store.tracks.some((track) => track.kind === 'midi'),
      hasScoreWindow: store.clipLengthPpq > 0,
    }),
  );

  const exportLoopRegion = computed<MixdownRangePpq | null>(() =>
    options.loopEnabled.value && options.loopEndPpq.value > options.loopStartPpq.value
      ? { startPpq: options.loopStartPpq.value, endPpq: options.loopEndPpq.value }
      : null,
  );

  function openExportDialog(): void {
    options.closeProjectMenu();
    exportDialogOpen.value = true;
  }

  /** Routes a direct unavailable invocation through the app error surface. */
  function reportMusicXmlUnavailable(reason: string): void {
    void Promise.resolve()
      .then(() =>
        options.runAction(async () => {
          throw new Error(`MusicXML export unavailable: ${reason}`);
        }),
      )
      .catch(() => {
        // The application runner reports the error. Test/embedding runners may
        // reject instead; the returned availability result remains the signal
        // for those callers and this prevents an unhandled rejection.
      });
  }

  function exportDawprojectAction(): void {
    options.closeProjectMenu();
    void options.runAction(async () => {
      const doc = serializeProject();
      const loss = inspectDawprojectExportLoss(doc);
      if (!(await confirmLossReport(loss, t.value.shell.project.dawprojectLoss))) return;
      const exported = await exportDawprojectWithReport(doc, { includeAudio: true });
      if (!exported.completeness.complete) {
        const ok = await confirmDialog({
          title: t.value.shell.project.mediaCompleteness.title,
          message: formatMessage(t.value.shell.project.mediaCompleteness.message, {
            items: formatMediaCompletenessReport(exported.completeness),
          }),
          confirmLabel: t.value.shell.project.mediaCompleteness.confirm,
        });
        if (!ok) return;
      }
      options.downloadBlobFile(
        new Blob([new Uint8Array(exported.bytes)], { type: 'application/zip' }),
        dawprojectFilename(store.projectName),
      );
    });
  }

  /** The document as a MusicXML export engraves it: every track, or the active clip. */
  function scoredDocument(fullScore: boolean): ProjectDocument {
    const doc = serializeProject();
    if (fullScore) return doc;
    const clip = store.activeClip;
    const trackIndex = clip ? store.tracks.findIndex((track) => track.id === clip.trackId) : -1;
    const track = doc.tracks[trackIndex];
    if (!clip || !track) return { ...doc, tracks: [] };
    const clipIndex = store.clips
      .filter((entry) => entry.trackId === clip.trackId)
      .findIndex((entry) => entry.id === clip.id);
    const scored = track.clips[clipIndex];
    return { ...doc, tracks: [{ ...track, clips: scored ? [scored] : [] }] };
  }

  /**
   * Starts MusicXML export and returns the same eligibility result consumed by
   * menu callers. An unavailable action is therefore observable even when a
   * caller invokes it directly rather than through a disabled menu row.
   */
  function exportMusicXmlAction(): ScoreExportAvailability {
    options.closeProjectMenu();
    const availability = musicXmlAvailability.value;
    if (!availability.available) {
      reportMusicXmlUnavailable(availability.reason ?? 'unknown');
      return availability;
    }
    void options.runAction(async () => {
      const clip = store.activeClip;
      const currentAvailability = musicXmlAvailability.value;
      if (!currentAvailability.available) {
        throw new Error(`MusicXML export unavailable: ${currentAvailability.reason}`);
      }
      const fullScore = currentAvailability.mode === 'full-score';
      if (!clip && !fullScore) {
        throw new Error('MusicXML export unavailable: active-midi-clip-required');
      }
      const scoreWindow = scoreClipWindow({
        clipStartPpq: store.clipStartPpq,
        clipLengthPpq: store.clipLengthPpq,
        pickupLengthPpq: store.pickupLengthPpq,
        timeSignatures: store.timeSignatures,
      });
      const keyFifths = keyFifthsForScaleHighlight(store.scaleHighlight);
      const divisionPpq =
        SCORE_DISPLAY_QUANTIZE_DIVISION_PPQ[store.scoreDisplaySettings.displayQuantizeKey];
      const loss = inspectMusicXmlExportLoss(scoredDocument(fullScore), divisionPpq);
      if (!(await confirmLossReport(loss, t.value.shell.project.musicXmlExportLoss))) return;
      const score = await buildProjectScore(store, {
        divisionPpq,
        timeSig: scoreWindow.timeSig,
        measureLenPpq: scoreWindow.measureLenPpq,
        clipLengthPpq: scoreWindow.clipLengthPpq,
        timeSignatures: store.timeSignatures,
        pickupLengthPpq: store.pickupLengthPpq,
        keyFifths,
        chordsEnabled: store.scoreDisplaySettings.chordsEnabled,
        fullScoreEnabled: fullScore,
        estimateFingering: store.scoreDisplaySettings.estimateFingering,
        grandStaffSplitPitch: store.scoreDisplaySettings.grandStaffSplitPitch,
        layoutSettings: store.scoreDisplaySettings,
      });
      options.downloadBlobFile(
        new Blob([serializeMusicXml(score)], { type: MUSICXML_MIME }),
        projectFilename(store.projectName, '.musicxml', 'score'),
      );
    });
    return availability;
  }

  return {
    exportDialogOpen,
    exportLoopRegion,
    musicXmlAvailability,
    scoreExportAvailability: musicXmlAvailability,
    exportDawprojectAction,
    exportMusicXmlAction,
    openExportDialog,
  };
}

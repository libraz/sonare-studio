import { type ComputedRef, computed, type Ref, ref } from 'vue';
import { keyFifthsForScaleHighlight } from '@/components/lists/key-modes';
import { confirmLossReport } from '@/composables/useLossConfirm';
import { dawprojectFilename, exportDawprojectWithReport } from '@/export/dawproject';
import { inspectDawprojectExportLoss } from '@/export/dawproject/export-loss';
import type { MixdownRangePpq } from '@/export/mixdown';
import { projectFilename } from '@/lib/filename';
import { musicXmlBlob, mxlBlob } from '@/notation/io';
import { inspectMusicXmlExportLoss, serializeMusicXml } from '@/notation/musicxml';
import { scoreClipWindow } from '@/notation/score-clip-window';
import { createBrowserBackupWithReport } from '@/persistence/backup';
import { gatherProjectBundleWithReport } from '@/persistence/bundle';
import { downloadBrowserBackup, downloadSzd } from '@/persistence/local-file';
import { encodeSzdStreaming } from '@/persistence/szd';
import { SCORE_DISPLAY_QUANTIZE_DIVISION_PPQ } from '@/project/annotations';
import { exportProjectClipFile, exportProjectSmf } from '@/project/export';
import {
  formatMediaCompletenessReport,
  type MediaCompletenessReport,
} from '@/project/media-completeness';
import { serializeProject } from '@/project/serialization';
import { useProjectStore } from '@/project/store';
import { formatMessage, useI18n } from '@/ui/i18n';
import {
  scoreExportAvailability as resolveScoreExportAvailability,
  type ScoreExportAvailability,
} from '@/ui/score/export-availability';
import { buildProjectScore, musicXmlScoredDocument } from '@/ui/score/use-score-notation';

type ConfirmAction = (
  message: string,
  opts?: { danger?: boolean; confirmLabel?: string; title?: string },
) => Promise<boolean>;
type RunAction = (action: () => Promise<void>) => Promise<void>;
type DownloadBlobFile = (blob: Blob, filename: string) => void;

type ScoreFileFormat = 'musicxml' | 'mxl';

export interface ProjectExportOptions {
  closeProjectMenu: () => void;
  confirmLossAction: ConfirmAction;
  downloadBlobFile: DownloadBlobFile;
  loopEnabled: Ref<boolean>;
  loopEndPpq: Ref<number>;
  loopStartPpq: Ref<number>;
  /** Whether OPFS media exists to bundle into a portable archive. */
  opfsAvailable: boolean;
  runAction: RunAction;
}

/** Export state and actions returned by {@link useProjectExport}. */
export interface ProjectExport {
  exportDialogOpen: Ref<boolean>;
  /** The loop range offered as an export region, or null when the loop is off or empty. */
  exportLoopRegion: ComputedRef<MixdownRangePpq | null>;
  musicXmlAvailability: ComputedRef<ScoreExportAvailability>;
  exportDawprojectAction(): void;
  exportMusicXmlAction(): ScoreExportAvailability;
  exportMxlAction(): ScoreExportAvailability;
  exportSzdAction(): void;
  exportBrowserBackupAction(): void;
  exportSmfAction(): void;
  exportMidi2Action(): void;
  openExportDialog(): void;
}

/**
 * Project-menu exports that leave the browser: DAWproject, MusicXML, the
 * portable .szd archive, the whole-browser backup, and Standard MIDI / MIDI 2.0
 * clip files. Incomplete media and reported loss are confirmed before writing.
 */
export function useProjectExport(options: ProjectExportOptions): ProjectExport {
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

  /** Localized text for an availability reason; an unrecognized code falls back to the generic text. */
  function musicXmlUnavailableMessage(reason: string | null): string {
    const messages: Record<string, string> = t.value.notices.musicXmlUnavailable;
    return messages[reason ?? ''] ?? t.value.notices.musicXmlUnavailable.unknown;
  }

  /** Routes a direct unavailable invocation through the app error surface. */
  function reportMusicXmlUnavailable(reason: string | null): void {
    void Promise.resolve()
      .then(() =>
        options.runAction(async () => {
          throw new Error(musicXmlUnavailableMessage(reason));
        }),
      )
      .catch(() => {
        // The application runner reports the error. Test/embedding runners may
        // reject instead; the returned availability result remains the signal
        // for those callers and this prevents an unhandled rejection.
      });
  }

  async function confirmIncompletePortableExport(
    report: MediaCompletenessReport,
  ): Promise<boolean> {
    if (report.complete) return true;
    return options.confirmLossAction(
      formatMessage(t.value.shell.project.mediaCompleteness.message, {
        items: formatMediaCompletenessReport(report),
      }),
      {
        title: t.value.shell.project.mediaCompleteness.title,
        confirmLabel: t.value.shell.project.mediaCompleteness.confirm,
      },
    );
  }

  function exportDawprojectAction(): void {
    options.closeProjectMenu();
    void options.runAction(async () => {
      const doc = serializeProject();
      const loss = inspectDawprojectExportLoss(doc);
      if (!(await confirmLossReport(loss, t.value.shell.project.dawprojectLoss))) return;
      const exported = await exportDawprojectWithReport(doc, { includeAudio: true });
      if (!(await confirmIncompletePortableExport(exported.completeness))) return;
      options.downloadBlobFile(
        new Blob([new Uint8Array(exported.bytes)], { type: 'application/zip' }),
        dawprojectFilename(store.projectName),
      );
    });
  }

  /**
   * Starts a MusicXML (.musicxml or compressed .mxl) export and returns the
   * same eligibility result consumed by menu callers. An unavailable action is
   * therefore observable even when a caller invokes it directly rather than
   * through a disabled menu row.
   */
  function exportScoreFileAction(format: ScoreFileFormat): ScoreExportAvailability {
    options.closeProjectMenu();
    const availability = musicXmlAvailability.value;
    if (!availability.available) {
      reportMusicXmlUnavailable(availability.reason);
      return availability;
    }
    void options.runAction(async () => {
      const clip = store.activeClip;
      const currentAvailability = musicXmlAvailability.value;
      if (!currentAvailability.available) {
        throw new Error(musicXmlUnavailableMessage(currentAvailability.reason));
      }
      const fullScore = currentAvailability.mode === 'full-score';
      if (!clip && !fullScore) {
        throw new Error(musicXmlUnavailableMessage('active-midi-clip-required'));
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
      const loss = inspectMusicXmlExportLoss(musicXmlScoredDocument(store, fullScore), divisionPpq);
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
      const xml = serializeMusicXml(score);
      options.downloadBlobFile(
        format === 'mxl' ? mxlBlob(xml) : musicXmlBlob(xml),
        projectFilename(store.projectName, format === 'mxl' ? '.mxl' : '.musicxml', 'score'),
      );
    });
    return availability;
  }

  const exportMusicXmlAction = (): ScoreExportAvailability => exportScoreFileAction('musicxml');
  const exportMxlAction = (): ScoreExportAvailability => exportScoreFileAction('mxl');

  function exportSzdAction(): void {
    options.closeProjectMenu();
    void options.runAction(async () => {
      const doc = serializeProject();
      // Disk exports travel to other machines/browsers, so bundle the
      // referenced audio + SoundFonts the OPFS store would otherwise hold.
      const gathered = options.opfsAvailable ? await gatherProjectBundleWithReport(doc) : undefined;
      if (gathered && !(await confirmIncompletePortableExport(gathered.report))) return;
      const bundle = gathered?.bundle;
      const bytes = await encodeSzdStreaming(doc, { savedAt: new Date().toISOString() }, bundle);
      downloadSzd(store.projectName, bytes);
    });
  }

  function exportBrowserBackupAction(): void {
    options.closeProjectMenu();
    void options.runAction(async () => {
      const backup = await createBrowserBackupWithReport();
      if (!(await confirmIncompletePortableExport(backup.completeness))) return;
      downloadBrowserBackup('sonare-studio', backup.bytes);
    });
  }

  function exportSmfAction(): void {
    options.closeProjectMenu();
    void options.runAction(async () => {
      const result = await exportProjectSmf();
      const copy = t.value.shell.project.midiExportLoss;
      if (
        !(await confirmLossReport(
          result.loss,
          { ...copy.smf, items: copy.items },
          options.confirmLossAction,
        ))
      ) {
        return;
      }
      options.downloadBlobFile(
        new Blob([new Uint8Array(result.bytes)], { type: 'audio/midi' }),
        result.filename,
      );
    });
  }

  function exportMidi2Action(): void {
    options.closeProjectMenu();
    void options.runAction(async () => {
      const result = exportProjectClipFile();
      const copy = t.value.shell.project.midiExportLoss;
      if (
        !(await confirmLossReport(
          result.loss,
          { ...copy.midi2, items: copy.items },
          options.confirmLossAction,
        ))
      ) {
        return;
      }
      options.downloadBlobFile(
        new Blob([new Uint8Array(result.bytes)], { type: 'audio/midi' }),
        result.filename,
      );
    });
  }

  return {
    exportDialogOpen,
    exportLoopRegion,
    musicXmlAvailability,
    exportDawprojectAction,
    exportMusicXmlAction,
    exportMxlAction,
    exportSzdAction,
    exportBrowserBackupAction,
    exportSmfAction,
    exportMidi2Action,
    openExportDialog,
  };
}

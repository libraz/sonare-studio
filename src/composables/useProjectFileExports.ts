/**
 * Project-menu exports that leave the browser: the portable .szd archive, the
 * whole-browser backup, and Standard MIDI / MIDI 2.0 clip files.
 */

import { confirmLossReport } from '@/composables/useLossConfirm';
import { createBrowserBackupWithReport } from '@/persistence/backup';
import { gatherProjectBundleWithReport } from '@/persistence/bundle';
import { downloadBrowserBackup, downloadSzd } from '@/persistence/local-file';
import { encodeSzdStreaming } from '@/persistence/szd';
import { exportProjectClipFile, exportProjectSmf } from '@/project/export';
import {
  formatMediaCompletenessReport,
  type MediaCompletenessReport,
} from '@/project/media-completeness';
import { serializeProject } from '@/project/serialization';
import { useProjectStore } from '@/project/store';
import { formatMessage, useI18n } from '@/ui/i18n';

type ConfirmAction = (
  message: string,
  opts?: { danger?: boolean; confirmLabel?: string; title?: string },
) => Promise<boolean>;
type RunAction = (action: () => Promise<void>) => Promise<void>;
type DownloadBlobFile = (blob: Blob, filename: string) => void;

/** Configuration for {@link useProjectFileExports}. */
export interface ProjectFileExportsOptions {
  closeProjectMenu: () => void;
  confirmLossAction: ConfirmAction;
  downloadBlobFile: DownloadBlobFile;
  /** Whether OPFS media exists to bundle into a portable archive. */
  opfsAvailable: boolean;
  runAction: RunAction;
}

/** Export actions returned by {@link useProjectFileExports}. */
export interface ProjectFileExports {
  exportSzdAction(): void;
  exportBrowserBackupAction(): void;
  exportSmfAction(): void;
  exportMidi2Action(): void;
}

/**
 * Creates the project-menu actions that download the project or the browser
 * store, confirming incomplete media and reported loss first.
 *
 * @param options - Shell confirmations, the download sink and OPFS availability.
 * @returns The export actions.
 */
export function useProjectFileExports(options: ProjectFileExportsOptions): ProjectFileExports {
  const { closeProjectMenu, confirmLossAction, downloadBlobFile, opfsAvailable, runAction } =
    options;
  const store = useProjectStore();
  const { t } = useI18n();

  async function confirmIncompletePortableExport(
    report: MediaCompletenessReport,
  ): Promise<boolean> {
    if (report.complete) return true;
    return confirmLossAction(
      formatMessage(t.value.shell.project.mediaCompleteness.message, {
        items: formatMediaCompletenessReport(report),
      }),
      {
        title: t.value.shell.project.mediaCompleteness.title,
        confirmLabel: t.value.shell.project.mediaCompleteness.confirm,
      },
    );
  }

  function exportSzdAction(): void {
    closeProjectMenu();
    void runAction(async () => {
      const doc = serializeProject();
      // Disk exports travel to other machines/browsers, so bundle the
      // referenced audio + SoundFonts the OPFS store would otherwise hold.
      const gathered = opfsAvailable ? await gatherProjectBundleWithReport(doc) : undefined;
      if (gathered && !(await confirmIncompletePortableExport(gathered.report))) return;
      const bundle = gathered?.bundle;
      const bytes = await encodeSzdStreaming(doc, { savedAt: new Date().toISOString() }, bundle);
      downloadSzd(store.projectName, bytes);
    });
  }

  function exportBrowserBackupAction(): void {
    closeProjectMenu();
    void runAction(async () => {
      const backup = await createBrowserBackupWithReport();
      if (!(await confirmIncompletePortableExport(backup.completeness))) return;
      downloadBrowserBackup('sonare-studio', backup.bytes);
    });
  }

  function exportSmfAction(): void {
    closeProjectMenu();
    void runAction(async () => {
      const result = await exportProjectSmf();
      const copy = t.value.shell.project.midiExportLoss;
      if (
        !(await confirmLossReport(
          result.loss,
          { ...copy.smf, items: copy.items },
          confirmLossAction,
        ))
      ) {
        return;
      }
      downloadBlobFile(
        new Blob([new Uint8Array(result.bytes)], { type: 'audio/midi' }),
        result.filename,
      );
    });
  }

  function exportMidi2Action(): void {
    closeProjectMenu();
    void runAction(async () => {
      const result = exportProjectClipFile();
      const copy = t.value.shell.project.midiExportLoss;
      if (
        !(await confirmLossReport(
          result.loss,
          { ...copy.midi2, items: copy.items },
          confirmLossAction,
        ))
      ) {
        return;
      }
      downloadBlobFile(
        new Blob([new Uint8Array(result.bytes)], { type: 'audio/midi' }),
        result.filename,
      );
    });
  }

  return { exportSzdAction, exportBrowserBackupAction, exportSmfAction, exportMidi2Action };
}

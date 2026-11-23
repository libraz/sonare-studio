/**
 * Imports from interchange formats (Standard MIDI File, MusicXML, DAWproject)
 * that replace the live document, including relinking DAWproject external audio.
 */

import { type Ref, ref } from 'vue';
import { confirmLossReport } from '@/composables/useLossConfirm';
import { importDawprojectWithMediaResult } from '@/export/dawproject';
import { preflightXmlBytes } from '@/lib/xml-preflight';
import { importMusicXmlInWorker } from '@/notation/musicxml-import-client';
import { extractMusicXmlFromMxl } from '@/notation/musicxml-mxl';
import { createAudioAssetTransaction } from '@/persistence/asset-transaction';
import {
  matchPickedExternalAudioFile,
  pickAndReadDawproject,
  pickAndReadExternalAudioFiles,
  pickViaInputElement,
  readFileBytesBounded,
} from '@/persistence/local-file';
import { MAX_SMF_FILE_BYTES } from '@/persistence/resource-limits';
import { createAssetReferenceGuard } from '@/project/asset-references';
import type { ProjectDocument } from '@/project/serialization';
import { midiFileToProjectDocument } from '@/project/smf-import';
import { useProjectStore } from '@/project/store';
import { formatMessage, useI18n } from '@/ui/i18n';

type ConfirmAction = (
  message: string,
  opts?: { danger?: boolean; confirmLabel?: string; title?: string },
) => Promise<boolean>;
type RunAction = (action: () => Promise<void>) => Promise<void>;

/** Configuration for {@link useForeignFormatImports}. */
export interface ForeignFormatImportsOptions {
  closeProjectMenu: () => void;
  confirmAction: ConfirmAction;
  /** Resolves true when there are no unsaved changes or the user discards them. */
  confirmDiscard: () => Promise<boolean>;
  confirmLossAction: ConfirmAction;
  errorMessage: Ref<string>;
  /** Makes an imported document the live project. */
  replaceProjectDocument: (document: ProjectDocument) => Promise<void>;
  /** Makes the project just loaded the clean saved state and closes the open/start surfaces. */
  settleLoadedProject: () => Promise<void>;
  runAction: RunAction;
}

/** Import actions returned by {@link useForeignFormatImports}. */
export interface ForeignFormatImports {
  /** Hidden file input the MIDI import action clicks. */
  midiImportInput: Ref<HTMLInputElement | null>;
  importMidiAction(): void;
  importMusicXmlAction(): void;
  importDawprojectAction(): void;
  onMidiImportChange(event: Event): void;
}

/**
 * Creates the project-menu actions that import an interchange file as the
 * live project, each confirming discard and reported loss first.
 *
 * @param options - Shell confirmations and the document-replacement steps.
 * @returns The MIDI file input and the import actions.
 */
export function useForeignFormatImports(
  options: ForeignFormatImportsOptions,
): ForeignFormatImports {
  const {
    closeProjectMenu,
    confirmAction,
    confirmDiscard,
    confirmLossAction,
    errorMessage,
    replaceProjectDocument,
    settleLoadedProject,
    runAction,
  } = options;
  const store = useProjectStore();
  const { t } = useI18n();
  const midiImportInput = ref<HTMLInputElement | null>(null);

  function importMidiAction(): void {
    closeProjectMenu();
    midiImportInput.value?.click();
  }

  function importMusicXmlAction(): void {
    closeProjectMenu();
    void runAction(async () => {
      if (!(await confirmDiscard())) return;
      const picked = await pickViaInputElement({
        accept: '.musicxml,.xml,.mxl',
        read: async (files) => {
          const file = files[0];
          if (!file) return null;
          preflightXmlBytes(file.size, file.name);
          const isMxl = file.name.toLowerCase().endsWith('.mxl');
          return {
            name: file.name,
            text: isMxl
              ? extractMusicXmlFromMxl(new Uint8Array(await file.arrayBuffer()), file.name)
              : await file.text(),
          };
        },
      });
      if (!picked) return;
      const imported = await importMusicXmlInWorker(picked.text, picked.name);
      if (
        !(await confirmLossReport(
          imported.report,
          t.value.shell.project.musicXmlLoss,
          confirmLossAction,
        ))
      ) {
        return;
      }
      await replaceProjectDocument(imported.document);
      await settleLoadedProject();
    });
  }

  function createExternalAudioResolver(): (path: string) => Promise<Uint8Array | null> {
    let pickedFiles = null as ReturnType<typeof pickAndReadExternalAudioFiles> | null;
    const explicitRelinks = new Map<string, Uint8Array | null>();
    return async (path: string) => {
      if (explicitRelinks.has(path)) return explicitRelinks.get(path) ?? null;
      pickedFiles ??= pickAndReadExternalAudioFiles();
      const files = await pickedFiles;
      if (!files || files.length === 0) return null;
      const match = matchPickedExternalAudioFile(path, files);
      if (match.status === 'exact-path' || match.status === 'unique-basename') {
        return match.file.bytes;
      }
      if (match.status === 'unresolved') return null;

      const candidates = match.files
        .map((file) => file.relativePath ?? file.name)
        .sort()
        .join('\n');
      const confirmed = await confirmAction(
        formatMessage(t.value.shell.project.externalMediaRelink.message, {
          path,
          candidates,
        }),
        {
          title: t.value.shell.project.externalMediaRelink.title,
          confirmLabel: t.value.shell.project.externalMediaRelink.confirm,
        },
      );
      if (!confirmed) {
        explicitRelinks.set(path, null);
        return null;
      }
      const selected = await pickAndReadExternalAudioFiles();
      const selectedMatch = matchPickedExternalAudioFile(path, selected ?? []);
      const resolved =
        selectedMatch.status === 'exact-path' || selectedMatch.status === 'unique-basename'
          ? selectedMatch.file.bytes
          : selected?.length === 1
            ? selected[0].bytes
            : null;
      explicitRelinks.set(path, resolved);
      return resolved;
    };
  }

  function importDawprojectAction(): void {
    closeProjectMenu();
    void runAction(async () => {
      if (!(await confirmDiscard())) return;
      const picked = await pickAndReadDawproject();
      if (!picked) return;
      if (!picked.name.toLowerCase().endsWith('.dawproject')) {
        errorMessage.value = formatMessage(t.value.shell.project.importDawprojectInvalidType, {
          name: picked.name,
        });
        return;
      }
      // Leases hold every ingested asset through the loss dialog until the
      // imported document references it.
      const assets = createAudioAssetTransaction();
      try {
        const imported = await importDawprojectWithMediaResult(picked.bytes, {
          resolveExternalAudio: createExternalAudioResolver(),
          save: assets.save,
        });
        if (
          !(await confirmLossReport(
            imported.loss,
            t.value.shell.project.dawprojectImportLoss,
            confirmLossAction,
          ))
        ) {
          await assets.rollback();
          return;
        }
        await replaceProjectDocument(imported.document);
        assets.commit();
      } catch (error) {
        await assets.rollback(createAssetReferenceGuard(store));
        throw error;
      }
      await settleLoadedProject();
    });
  }

  function onMidiImportChange(event: Event): void {
    const input = event.target as HTMLInputElement | null;
    const file = input?.files?.[0] ?? null;
    if (input) input.value = '';
    if (!file) return;
    void runAction(async () => {
      if (!(await confirmDiscard())) return;
      const doc = await midiFileToProjectDocument(
        await readFileBytesBounded(file, MAX_SMF_FILE_BYTES),
        file.name,
      );
      await replaceProjectDocument(doc);
      await settleLoadedProject();
    });
  }

  return {
    midiImportInput,
    importMidiAction,
    importMusicXmlAction,
    importDawprojectAction,
    onMidiImportChange,
  };
}

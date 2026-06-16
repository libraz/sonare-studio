import { computed, type Ref, ref } from 'vue';
import { dawprojectFilename, exportDawproject } from '@/export/dawproject';
import type { MixdownRangePpq } from '@/export/mixdown';
import { serializeProject } from '@/project/serialization';
import { useProjectStore } from '@/project/store';

type RunAction = (action: () => Promise<void>) => Promise<void>;
type DownloadBlobFile = (blob: Blob, filename: string) => void;

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

  function exportDawprojectAction(): void {
    options.closeProjectMenu();
    void options.runAction(async () => {
      const bytes = await exportDawproject(serializeProject(), { includeAudio: true });
      options.downloadBlobFile(
        new Blob([new Uint8Array(bytes)], { type: 'application/zip' }),
        dawprojectFilename(store.projectName),
      );
    });
  }

  return {
    exportDialogOpen,
    exportLoopRegion,
    exportDawprojectAction,
    openExportDialog,
  };
}

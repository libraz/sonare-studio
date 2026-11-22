import { DEBUG_SURFACE_ENABLED } from '@/lib/debug-surface';
import { downloadBlob } from '@/lib/download';

export function useFileDownloads() {
  let lastDownload: { filename: string; blob: Blob } | null = null;

  function downloadBlobFile(blob: Blob, filename: string): void {
    if (DEBUG_SURFACE_ENABLED) lastDownload = { filename, blob };
    downloadBlob(blob, filename);
  }

  return {
    downloadBlobFile,
    lastDownload: () => lastDownload,
  };
}

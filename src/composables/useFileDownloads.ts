import { downloadBlob } from '@/lib/download';

export function useFileDownloads() {
  let lastDownload: { filename: string; blob: Blob } | null = null;

  function downloadBlobFile(blob: Blob, filename: string): void {
    if (import.meta.env.DEV) lastDownload = { filename, blob };
    downloadBlob(blob, filename);
  }

  return {
    downloadBlobFile,
    lastDownload: () => lastDownload,
  };
}

export function useFileDownloads() {
  let lastDownload: { filename: string; blob: Blob } | null = null;

  function downloadBlobFile(blob: Blob, filename: string): void {
    if (import.meta.env.DEV) lastDownload = { filename, blob };
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  return {
    downloadBlobFile,
    lastDownload: () => lastDownload,
  };
}

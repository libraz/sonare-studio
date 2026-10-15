/** Delay before releasing the object URL so the browser can begin reading the blob. */
const REVOKE_DELAY_MS = 1000;

/** Triggers a browser Blob download through a transient object URL and anchor. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Some browsers start the download asynchronously; revoking at once can cancel it.
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
}

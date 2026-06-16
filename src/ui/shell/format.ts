export function formatSavedAt(date: Date): string {
  return `saved ${date.toLocaleTimeString()}`;
}

export function formatSize(bytes: number): string {
  return bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`;
}

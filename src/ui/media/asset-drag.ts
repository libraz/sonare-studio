/**
 * Drag-and-drop payload helpers for media browser assets. Rows set a custom
 * MIME entry carrying the asset id (plus a text/plain fallback) so any drop
 * target — e.g. a future arrangement lane — can accept asset drags without
 * coupling to the browser component.
 */

/** Custom DataTransfer MIME type carrying an audio asset id. */
export const ASSET_DRAG_MIME = 'application/x-sonare-asset';

/**
 * Writes an asset drag payload onto a DataTransfer: the asset id under
 * {@link ASSET_DRAG_MIME} and as `text/plain`, with a copy drag effect.
 *
 * @param dataTransfer - The dragstart event's DataTransfer.
 * @param assetId - The dragged asset id.
 */
export function setAssetDragData(dataTransfer: DataTransfer, assetId: string): void {
  dataTransfer.setData(ASSET_DRAG_MIME, assetId);
  dataTransfer.setData('text/plain', assetId);
  dataTransfer.effectAllowed = 'copy';
}

/** True when the DataTransfer carries an asset drag payload. */
export function hasAssetDrag(dataTransfer: DataTransfer | null): boolean {
  if (!dataTransfer) return false;
  return Array.from(dataTransfer.types).includes(ASSET_DRAG_MIME);
}

/**
 * Reads the dragged asset id from a DataTransfer.
 *
 * @param dataTransfer - The drop event's DataTransfer.
 * @returns The asset id, or null when this is not an asset drag.
 */
export function readAssetDragId(dataTransfer: DataTransfer | null): string | null {
  if (!hasAssetDrag(dataTransfer) || !dataTransfer) return null;
  const id = dataTransfer.getData(ASSET_DRAG_MIME);
  return id.length > 0 ? id : null;
}

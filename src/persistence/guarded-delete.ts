/** Inputs for {@link deleteSlotsGuarded}. */
export interface GuardedSlotDeletion {
  /** True only when the index or manifest that classifies slots was read successfully. */
  inventoryRead: boolean;
  /** Slots proposed for deletion. */
  candidates: Iterable<string>;
  /** Slots the inventory still references; these are never deleted. */
  retained: ReadonlySet<string>;
  /** Performs the actual removal of one slot. */
  remove: (slot: string) => Promise<void>;
}

/**
 * The single entry point for pruning stored slots. Refuses to delete anything
 * when the inventory it depends on was not read, and skips every slot that the
 * inventory still references.
 *
 * @returns The slots that were removed, in order.
 */
export async function deleteSlotsGuarded(request: GuardedSlotDeletion): Promise<string[]> {
  if (!request.inventoryRead) return [];
  const removed: string[] = [];
  for (const slot of request.candidates) {
    if (request.retained.has(slot)) continue;
    await request.remove(slot);
    removed.push(slot);
  }
  return removed;
}

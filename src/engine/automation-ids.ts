/**
 * Resolves an engine automation id, or returns undefined when the engine does
 * not know the target yet: an unknown track, bus, insert or parameter is a
 * `RangeError`, and a target earlier configuration has not created (no master
 * strip) is an `InvalidState` SonareError. Any other failure propagates.
 *
 * @param resolve Calls one of the engine's `resolve*AutomationId` methods.
 */
export function resolveAutomationId(resolve: () => number): number | undefined {
  try {
    return resolve();
  } catch (error) {
    if (error instanceof RangeError) return undefined;
    if ((error as { codeName?: unknown } | null)?.codeName === 'InvalidState') return undefined;
    throw error;
  }
}

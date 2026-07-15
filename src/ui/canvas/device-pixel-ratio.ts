/** Minimal browser surface used by the DPR observer (injectable for tests). */
export interface DevicePixelRatioEnvironment {
  readonly devicePixelRatio?: number;
  matchMedia?(query: string): MediaQueryList;
}

/**
 * Observes display-scale changes even when an element's CSS dimensions stay
 * unchanged. Each media-query change re-arms against the new ratio.
 */
export function observeDevicePixelRatio(
  callback: () => void,
  environment: DevicePixelRatioEnvironment = globalThis,
): () => void {
  let query: MediaQueryList | null = null;
  let disposed = false;

  const onChange = (): void => {
    query?.removeEventListener('change', onChange);
    query = null;
    if (disposed) return;
    callback();
    arm();
  };

  const arm = (): void => {
    if (disposed || typeof environment.matchMedia !== 'function') return;
    query = environment.matchMedia(`(resolution: ${environment.devicePixelRatio || 1}dppx)`);
    query.addEventListener('change', onChange, { once: true });
  };

  arm();
  return () => {
    disposed = true;
    query?.removeEventListener('change', onChange);
    query = null;
  };
}

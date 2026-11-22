/**
 * Whether the build carries the debug surface the browser smoke scenarios
 * drive: every dev server, and the static build made with VITE_SONARE_E2E=1.
 */
export const DEBUG_SURFACE_ENABLED = import.meta.env.DEV || import.meta.env.VITE_SONARE_E2E === '1';

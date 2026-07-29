import { createPinia } from 'pinia';
import { createApp } from 'vue';
import { vRadioGroup } from '@/ui/accessibility/radiogroup';
import { vTabList } from '@/ui/accessibility/tablist';
import { vTooltip } from '@/ui/tooltip';
import App from './App.vue';
import { markAppShellLoaded, registerServiceWorker } from './pwa';
// The display face for the wordmark — a modern variable grotesque, self-hosted
// so it ships with the bundle rather than depending on a font CDN at runtime.
// Only the Latin subset is fetched for the "sonare studio" mark thanks to its
// unicode-range. Registered before the tokens that reference it.
import '@fontsource-variable/bricolage-grotesque/standard.css';
// Global design tokens first, then the base layer (document reset, dark UA
// chrome, scrollbars), the shared control primitives, the keyboard-focus ring
// and the shared motion layer that build on them — imported here so they apply
// to the whole shell regardless of which panels are mounted.
import '@/ui/theme/tokens.css';
import '@/ui/theme/base.css';
import '@/ui/theme/controls.css';
import '@/ui/theme/settings-group.css';
import '@/ui/theme/focus-visible.css';
import '@/ui/theme/motion.css';
import '@/ui/theme/tooltip.css';

// Reaching this line proves the document and its entry module belong to the
// same release, so the inline recovery guard's marker can be released.
markAppShellLoaded();

createApp(App)
  .use(createPinia())
  .directive('tooltip', vTooltip)
  .directive('radiogroup', vRadioGroup)
  .directive('tablist', vTabList)
  .mount('#app');

void registerServiceWorker().catch((error) => {
  console.warn('Service Worker registration failed', error);
});

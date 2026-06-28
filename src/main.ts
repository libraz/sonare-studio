import { createPinia } from 'pinia';
import { createApp } from 'vue';
import App from './App.vue';
// Global design tokens first, then the base layer (document reset, dark UA
// chrome, scrollbars), the shared control primitives, the keyboard-focus ring
// and the shared motion layer that build on them — imported here so they apply
// to the whole shell regardless of which panels are mounted.
import '@/ui/theme/tokens.css';
import '@/ui/theme/base.css';
import '@/ui/theme/controls.css';
import '@/ui/theme/focus-visible.css';
import '@/ui/theme/motion.css';

createApp(App).use(createPinia()).mount('#app');

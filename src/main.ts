import { createPinia } from 'pinia';
import { createApp } from 'vue';
import App from './App.vue';
// Global keyboard-focus outline; imported here so it applies to the whole
// shell regardless of which panels are mounted.
import '@/ui/theme/focus-visible.css';

createApp(App).use(createPinia()).mount('#app');

<script setup lang="ts">
/**
 * sonare studio wordmark — the canonical logo, defined once and shared by the
 * app header, the start screen and the About dialog so the identity never
 * drifts between surfaces.
 *
 * Renders the gradient "sonare" mark with the muted "studio" subtitle. The
 * brand gradient lives in tokens.css (--brand-gradient) and re-tints per theme
 * automatically. `size` scales the whole mark.
 */
withDefaults(
  defineProps<{
    /** Visual size. Header uses 'sm'; dialogs use 'md'; the launcher uses 'lg'. */
    size?: 'sm' | 'md' | 'lg';
  }>(),
  { size: 'sm' },
);
</script>

<template>
  <span class="brandmark" :class="`brandmark-${size}`">
    <span class="brandmark-name">sonare</span>
    <span class="brandmark-sub">studio</span>
  </span>
</template>

<style scoped>
.brandmark {
  display: inline-flex;
  align-items: baseline;
  gap: 0.28em;
  font-family: var(--font-display);
  font-optical-sizing: auto;
  line-height: 1;
  user-select: none;
}

.brandmark-name {
  font-weight: 720;
  letter-spacing: 0;
  color: var(--text-1);
}

@supports ((-webkit-background-clip: text) or (background-clip: text)) {
  .brandmark-name {
    background: var(--brand-gradient);
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
    -webkit-text-fill-color: transparent;
  }
}

.brandmark-sub {
  font-weight: 420;
  color: var(--text-3);
}

.brandmark-sm {
  font-size: 16px;
}

.brandmark-md {
  font-size: 20px;
}

.brandmark-lg {
  font-size: 26px;
}
</style>

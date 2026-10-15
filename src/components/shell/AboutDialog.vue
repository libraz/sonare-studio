<script setup lang="ts">
import { computed } from 'vue';
import AppModal from '@/components/shell/AppModal.vue';
import BrandMark from '@/components/shell/BrandMark.vue';
import { APP_VERSION, BUILD_COMMIT, BUILD_TIME, formatBuildTime } from '@/lib/build-info';
import { useI18n } from '@/ui/i18n';

/**
 * About dialog — the app's identity and runtime build/environment facts
 * (app build stamp, audio-engine version, cross-origin isolation) that used to
 * clutter the transport bar and the Diagnostics disclosure. Read-only.
 */

defineProps<{
  /** Whether the dialog is visible. */
  open: boolean;
  /** libsonare audio-engine version string, or a placeholder while loading. */
  version: string;
  /** Whether the page is cross-origin isolated (SharedArrayBuffer available). */
  isolated: boolean;
}>();

const emit = defineEmits<{
  /** The user dismissed the dialog. */
  close: [];
}>();

const { locale, t } = useI18n();

const builtAt = computed(() => formatBuildTime(BUILD_TIME, locale.value));
</script>

<template>
  <AppModal :open="open" size="sm" :aria-label="t.dialogs.about.ariaLabel" @close="emit('close')">
    <template #title>{{ t.dialogs.about.title }}</template>

    <div class="about">
      <header class="about-identity">
        <BrandMark size="lg" />
        <p class="about-tagline">{{ t.dialogs.about.tagline }}</p>
        <p v-if="APP_VERSION" class="about-stamp">
          <span class="about-stamp-label">{{ t.dialogs.about.appVersion }}</span>
          <span class="about-stamp-version">{{ APP_VERSION }}</span>
          <template v-if="BUILD_COMMIT">
            <span class="about-stamp-sep" aria-hidden="true">·</span>
            <span class="about-stamp-label">{{ t.dialogs.about.commit }}</span>
            <span class="about-stamp-commit">{{ BUILD_COMMIT }}</span>
          </template>
        </p>
      </header>

      <dl class="about-facts">
        <div v-if="builtAt" class="about-row">
          <dt>{{ t.dialogs.about.builtAt }}</dt>
          <dd>{{ builtAt }}</dd>
        </div>
        <div class="about-row">
          <dt>{{ t.dialogs.about.audioEngine }}</dt>
          <dd><span class="about-muted">libsonare</span> {{ version }}</dd>
        </div>
        <div class="about-row">
          <dt>SharedArrayBuffer</dt>
          <dd>
            <span class="about-status" :class="{ 'is-on': isolated }">
              <span class="about-status-dot" aria-hidden="true"></span>
              {{ isolated ? t.dialogs.about.available : t.dialogs.about.unavailable }}
            </span>
          </dd>
        </div>
      </dl>
    </div>

    <template #actions>
      <button type="button" class="primary" @click="emit('close')">
        {{ t.common.close }}
      </button>
    </template>
  </AppModal>
</template>

<style scoped>
.about {
  display: flex;
  flex-direction: column;
  gap: var(--sp-6);
}

/* Identity first: the mark, what the app is, and which build is running. The
 * build stamp sits here rather than among the facts because it identifies the
 * app itself — untagged deploys have nothing else to name them by. */
.about-identity {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--sp-2);
  padding-top: var(--sp-1);
}

.about-tagline {
  margin: 0;
  font-size: var(--fs-sm);
  color: var(--text-3);
}

.about-stamp {
  display: inline-flex;
  align-items: baseline;
  gap: var(--sp-2);
  margin: var(--sp-2) 0 0;
  padding: var(--sp-2) var(--sp-4);
  background: var(--surface-3);
  border-radius: var(--radius-full);
  box-shadow: var(--control-edge);
  font-size: var(--fs-xs);
  font-variant-numeric: tabular-nums;
}

/* The chip is bare numbers on screen; assistive tech still gets the field names. */
.about-stamp-label {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

.about-stamp-version {
  color: var(--text-2);
  font-weight: var(--fw-medium);
}

.about-stamp-sep {
  color: var(--text-4);
}

.about-stamp-commit {
  color: var(--text-3);
  font-family: var(--font-mono);
}

/* Facts read as a grouped inset card, matching the settings-group idiom. */
.about-facts {
  display: flex;
  flex-direction: column;
  margin: 0;
  background: var(--surface-2);
  border-radius: var(--radius-lg);
  box-shadow: var(--control-edge), var(--shadow-1);
}

.about-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-4);
  min-height: 2.1rem;
  padding: var(--sp-3) var(--sp-5);
}

.about-row + .about-row {
  border-top: 1px solid var(--border-subtle);
}

.about-row dt {
  color: var(--text-3);
}

.about-row dd {
  margin: 0;
  text-align: right;
  color: var(--text-1);
  font-weight: var(--fw-medium);
  font-variant-numeric: tabular-nums;
}

/* Product name beside its version — the version is the fact, the name is context. */
.about-muted {
  color: var(--text-3);
  font-weight: var(--fw-normal);
}

/* Availability reads as a state, not a sentence: a dot carries it at a glance,
 * tinted to match the engine-status idiom in the header. */
.about-status {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-3);
  color: var(--text-2);
}

/* Unavailable is a degraded runtime, not a neutral off — it costs the engine
 * its shared memory, so it reads amber rather than grey. */
.about-status-dot {
  width: 7px;
  height: 7px;
  border-radius: var(--radius-full);
  background: var(--warning);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--warning) 24%, transparent);
}

.about-status.is-on .about-status-dot {
  background: var(--success);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--success) 24%, transparent);
}
</style>

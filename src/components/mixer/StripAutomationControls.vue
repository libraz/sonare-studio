<script setup lang="ts">
import { computed } from 'vue';
import { formatMessage, useI18n } from '@/ui/i18n';
import { automationStripMode, toggleAutomationStripMode } from '@/ui/mixer/automation-mode';

/**
 * The strip's session-only automation R/T/L button row. Read follows the lane
 * at the playhead; touch and latch record drags into the lane. The active mode
 * is mutually exclusive, and clicking it again turns it off. The mode map is
 * shared session state keyed by the strip target.
 */

const props = defineProps<{
  /** Strip target: a track id or 'master'. */
  target: number | 'master';
  /** Strip display name (for the accessible button labels). */
  name: string;
}>();

const { t } = useI18n();

const autoMode = computed(() => automationStripMode(props.target));
</script>

<template>
  <div class="strip-auto">
    <button
      type="button"
      class="toggle strip-auto-r"
      :class="{ on: autoMode === 'read' }"
      v-tooltip="t.shell.mixer.strip.automationReadTitle"
      :aria-label="formatMessage(t.shell.mixer.strip.automationRead, { name: props.name })"
      :aria-pressed="autoMode === 'read'"
      @click="toggleAutomationStripMode(props.target, 'read')"
    >
      R
    </button>
    <button
      type="button"
      class="toggle strip-auto-t"
      :class="{ on: autoMode === 'touch' }"
      v-tooltip="t.shell.mixer.strip.automationTouchTitle"
      :aria-label="formatMessage(t.shell.mixer.strip.automationTouch, { name: props.name })"
      :aria-pressed="autoMode === 'touch'"
      @click="toggleAutomationStripMode(props.target, 'touch')"
    >
      T
    </button>
    <button
      type="button"
      class="toggle strip-auto-l"
      :class="{ on: autoMode === 'latch' }"
      v-tooltip="t.shell.mixer.strip.automationLatchTitle"
      :aria-label="formatMessage(t.shell.mixer.strip.automationLatch, { name: props.name })"
      :aria-pressed="autoMode === 'latch'"
      @click="toggleAutomationStripMode(props.target, 'latch')"
    >
      L
    </button>
  </div>
</template>

<style scoped>
.strip-auto {
  display: flex;
  gap: var(--sp-1);
}

.strip-auto-r.on {
  color: var(--surface-0);
  background: var(--success);
}

.strip-auto-t.on {
  color: var(--surface-0);
  background: var(--warning);
}

.strip-auto-l.on {
  color: var(--surface-0);
  background: var(--danger);
}

.toggle {
  width: 16px;
  height: 14px;
  font: var(--fw-bold) var(--fs-chrome-lg) var(--font-sans);
  line-height: 1;
  color: var(--text-3);
  background: var(--surface-3);
  border-radius: 3px;
  padding: 0;
  cursor: pointer;
  box-shadow: var(--control-lift);
  transition:
    background var(--dur-2) var(--ease-out),
    color var(--dur-2) var(--ease-out),
    transform var(--dur-1) var(--ease-out);
}

.toggle:active {
  transform: scale(0.9);
}

.toggle.on {
  animation: toggle-latch var(--dur-3) var(--ease-spring);
}
</style>

<script setup lang="ts">
import type { MidiLearnHandle } from '@/composables/useMidiLearn';
import { useI18n } from '@/ui/i18n';
import {
  formatMidiCcBinding,
  type MidiLearnParam,
  type MidiLearnScope,
} from '@/ui/midi/midi-learn';

/**
 * MIDI-learn popover: binds hardware CC controllers to mixer strip gain/pan for
 * the master strip and every track. Arming a target listens for the next CC;
 * incoming CC then drives the real mixer command in realtime (audible). Press
 * a bound control again to re-learn, or clear it with the ✕.
 */

const props = defineProps<{
  /** MIDI-learn state and controls. */
  learn: MidiLearnHandle;
  /** Tracks to expose as bindable strips, in display order. */
  tracks: ReadonlyArray<{ id: number; name: string; color: string }>;
}>();

const emit = defineEmits<{
  /** Request the host close the panel. */
  close: [];
}>();

const { t } = useI18n();

/** The two bindable parameters per strip, in column order. */
const PARAMS: ReadonlyArray<{ param: MidiLearnParam; labelKey: 'volume' | 'pan' }> = [
  { param: 'gain', labelKey: 'volume' },
  { param: 'pan', labelKey: 'pan' },
];

/** Short caption for a target's button: its binding, listening, or a dash. */
function caption(param: MidiLearnParam, scope: MidiLearnScope): string {
  if (props.learn.isArmed(param, scope)) return t.value.shell.midiLearn.listening;
  const binding = props.learn.bindingFor(param, scope);
  return binding ? formatMidiCcBinding(binding) : t.value.shell.midiLearn.learn;
}
</script>

<template>
  <div class="midi-learn-panel" role="dialog" :aria-label="t.shell.midiLearn.label">
    <header class="ml-head">
      <h2 class="ml-title">{{ t.shell.midiLearn.title }}</h2>
      <button type="button" class="ml-close" :aria-label="t.shell.midiLearn.close" @click="emit('close')">
        ×
      </button>
    </header>

    <div class="ml-body">
      <div class="ml-row ml-row-head">
        <span class="ml-name">{{ t.shell.midiLearn.strip }}</span>
        <span v-for="col in PARAMS" :key="col.param" class="ml-col-head">
          {{ t.shell.midiLearn[col.labelKey] }}
        </span>
      </div>

      <div class="ml-row">
        <span class="ml-name ml-name-master">{{ t.shell.midiLearn.master }}</span>
        <span v-for="col in PARAMS" :key="col.param" class="ml-cell">
          <button
            type="button"
            class="ml-bind"
            :class="{
              'ml-bind-armed': learn.isArmed(col.param, 'master'),
              'ml-bind-set': !!learn.bindingFor(col.param, 'master'),
            }"
            @click="learn.arm(col.param, 'master')"
          >
            {{ caption(col.param, 'master') }}
          </button>
          <button
            v-if="learn.bindingFor(col.param, 'master')"
            type="button"
            class="ml-clear"
            :aria-label="t.shell.midiLearn.clearBinding"
            @click="learn.clear(col.param, 'master')"
          >
            ×
          </button>
        </span>
      </div>

      <div v-for="track in tracks" :key="track.id" class="ml-row">
        <span class="ml-name">
          <span class="ml-swatch" :style="{ background: track.color }" />
          {{ track.name }}
        </span>
        <span v-for="col in PARAMS" :key="col.param" class="ml-cell">
          <button
            type="button"
            class="ml-bind"
            :class="{
              'ml-bind-armed': learn.isArmed(col.param, track.id),
              'ml-bind-set': !!learn.bindingFor(col.param, track.id),
            }"
            @click="learn.arm(col.param, track.id)"
          >
            {{ caption(col.param, track.id) }}
          </button>
          <button
            v-if="learn.bindingFor(col.param, track.id)"
            type="button"
            class="ml-clear"
            :aria-label="t.shell.midiLearn.clearBinding"
            @click="learn.clear(col.param, track.id)"
          >
            ×
          </button>
        </span>
      </div>
    </div>

    <footer class="ml-foot">
      <span class="ml-hint">{{ t.shell.midiLearn.hint }}</span>
      <span class="ml-spacer" />
      <button
        type="button"
        class="ml-btn"
        :disabled="learn.bindings.size === 0 && learn.armed.value === null"
        @click="learn.clearAll()"
      >
        {{ t.shell.midiLearn.clearAll }}
      </button>
    </footer>
  </div>
</template>

<style scoped>
.midi-learn-panel {
  position: absolute;
  right: 0;
  bottom: calc(100% + var(--sp-2));
  z-index: 60;
  width: 320px;
  display: flex;
  flex-direction: column;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-pop);
  font-family: var(--font-sans);
  color: var(--text-2);
}

.ml-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--sp-2) var(--sp-3);
  border-bottom: 1px solid var(--border-subtle);
}

.ml-title {
  margin: 0;
  font-size: var(--fs-sm);
  font-weight: var(--fw-semibold);
  color: var(--text-1);
}

.ml-close {
  border: none;
  background: transparent;
  box-shadow: none;
  color: var(--text-3);
  font-size: var(--fs-lg);
  line-height: 1;
  cursor: pointer;
  padding: 0 var(--sp-1);
}

.ml-close:hover {
  color: var(--text-1);
}

.ml-body {
  display: flex;
  flex-direction: column;
  padding: var(--sp-2) var(--sp-3);
  gap: 2px;
  max-height: 50vh;
  overflow-y: auto;
}

.ml-row {
  display: grid;
  grid-template-columns: 1fr 5.5rem 5.5rem;
  align-items: center;
  gap: var(--sp-2);
}

.ml-row-head {
  padding-bottom: var(--sp-1);
  border-bottom: 1px solid var(--border-subtle);
}

.ml-col-head {
  font-size: var(--fs-xs);
  color: var(--text-4);
  text-align: center;
}

.ml-name {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  min-width: 0;
  font-size: var(--fs-xs);
  color: var(--text-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ml-name-master {
  font-weight: var(--fw-semibold);
  color: var(--text-1);
}

.ml-swatch {
  flex: 0 0 auto;
  width: 8px;
  height: 8px;
  border-radius: var(--radius-full);
}

.ml-cell {
  display: flex;
  align-items: center;
  gap: 2px;
}

.ml-bind {
  flex: 1 1 auto;
  min-width: 0;
  padding: 2px var(--sp-1);
  font-size: var(--fs-xs);
  font-variant-numeric: tabular-nums;
  text-align: center;
  border-radius: var(--radius-sm);
  background: var(--surface-3);
  color: var(--text-3);
  cursor: pointer;
  box-shadow: var(--control-lift);
}

.ml-bind:hover {
  color: var(--text-1);
  box-shadow: var(--control-lift-hover);
}

.ml-bind:active {
  box-shadow: var(--control-edge), var(--inset-well);
}

.ml-bind-set {
  color: var(--text-1);
  box-shadow: inset 0 0 0 1px var(--accent-muted), var(--raise-hi), var(--shadow-1);
}

.ml-bind-armed {
  background: var(--accent);
  color: var(--accent-text);
  box-shadow: inset 0 0 0 1px var(--accent), var(--raise-hi), var(--shadow-1);
}

.ml-clear {
  flex: 0 0 auto;
  border: none;
  background: transparent;
  box-shadow: none;
  color: var(--text-4);
  font-size: var(--fs-sm);
  line-height: 1;
  cursor: pointer;
  padding: 0 2px;
}

.ml-clear:hover {
  color: var(--danger-text);
}

.ml-foot {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-2) var(--sp-3);
  border-top: 1px solid var(--border-subtle);
}

.ml-hint {
  font-size: var(--fs-xs);
  color: var(--text-4);
}

.ml-spacer {
  flex: 1 1 auto;
}

.ml-btn {
  padding: var(--sp-1) var(--sp-2);
  font-size: var(--fs-xs);
  border-radius: var(--radius-sm);
  background: var(--surface-3);
  color: var(--text-2);
  cursor: pointer;
  box-shadow: var(--control-lift);
}

.ml-btn:hover:not(:disabled) {
  box-shadow: var(--control-lift-hover);
}

.ml-btn:active:not(:disabled) {
  box-shadow: var(--control-edge), var(--inset-well);
}

.ml-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import type { AnalyserBridge } from '@/engine/analyser';
import type { MeterSource } from '@/engine/meters';
import type { ScopeSource } from '@/engine/scope';
import { addMixerBus, addVcaGroup } from '@/project/commands';
import { MAX_VCA_GROUPS } from '@/project/mixer';
import { useProjectStore } from '@/project/store';
import type { EditorTrack } from '@/project/types';
import { formatMessage, useI18n } from '@/ui/i18n';
import BusStrip from './BusStrip.vue';
import ChannelStrip from './ChannelStrip.vue';
import MixerSnapshots from './MixerSnapshots.vue';
import VcaStrip from './VcaStrip.vue';

/**
 * Mixer panel for the editor dock: a horizontal scroll of channel strips
 * (one per project track, in track order) with the master strip pinned at
 * the right. Tracks can be hidden from the mixer view via the visibility
 * menu — that state is panel-local and does not touch the project. Send/return
 * buses render as inline strips after the track strips; their sends feed the
 * engine's realtime bus lanes.
 *
 * The master strip is fed by the summed-output meter source; track strips and
 * bus strips are fed via the meterFor / busMeterFor lookups (the engine
 * publishes a meter record per mixer lane and per bus). Strips without a source
 * show a placeholder meter.
 */

const props = withDefaults(
  defineProps<{
    /** Engine meter source for the master strip; null draws silent meters. */
    bridge?: MeterSource | null;
    /** Master analyser tap for the spectrum/goniometer; null draws placeholders. */
    analyser?: AnalyserBridge | null;
    /** Master engine scope source (per-target spectrum + goniometer). */
    masterScope?: ScopeSource | null;
    /** Per-track meter source lookup; null shows placeholder track meters. */
    meterFor?: ((trackId: number) => MeterSource | null) | null;
    /** Per-bus meter source lookup; null shows placeholder bus meters. */
    busMeterFor?: ((busId: string) => MeterSource | null) | null;
    /** Per-track scope source lookup (engine spectrum + goniometer). */
    scopeFor?: ((trackId: number) => ScopeSource | null) | null;
    /** Per-bus scope source lookup (engine spectrum + goniometer). */
    busScopeFor?: ((busId: string) => ScopeSource | null) | null;
    /** Playhead position getter in PPQ (strip automation follow/recording). */
    positionPpq?: () => number;
    /** True while the transport runs (strip automation touch recording). */
    isPlaying?: boolean;
  }>(),
  {
    bridge: null,
    analyser: null,
    masterScope: null,
    meterFor: null,
    busMeterFor: null,
    scopeFor: null,
    busScopeFor: null,
    positionPpq: undefined,
    isPlaying: false,
  },
);

const store = useProjectStore();
const { t } = useI18n();

/** Track ids hidden from the mixer view (panel-local, not persisted). */
const hiddenTrackIds = ref<ReadonlySet<number>>(new Set());

const visibleTracks = computed<EditorTrack[]>(() =>
  store.tracks.filter((track) => !hiddenTrackIds.value.has(track.id)),
);

const hiddenCount = computed(() => store.tracks.length - visibleTracks.value.length);

function toggleTrackVisible(trackId: number): void {
  const next = new Set(hiddenTrackIds.value);
  if (next.has(trackId)) next.delete(trackId);
  else next.add(trackId);
  hiddenTrackIds.value = next;
}

function showAllTracks(): void {
  hiddenTrackIds.value = new Set();
}

// --- View menu (visibility + buses) -------------------------------------------

const menuOpen = ref(false);
const menuEl = ref<HTMLDivElement | null>(null);

/** Surfaced when a bus command rejects. */
const error = ref('');

function onAddBus(): void {
  try {
    addMixerBus();
    error.value = '';
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

/** True while another VCA group can be created (the UI cap is reached). */
const canAddVca = computed(() => (store.mixer.vcaGroups?.length ?? 0) < MAX_VCA_GROUPS);

function onAddVca(): void {
  try {
    addVcaGroup();
    error.value = '';
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

function onDocumentPointerDown(event: PointerEvent): void {
  if (!(event.target instanceof Node) || !menuEl.value?.contains(event.target)) {
    menuOpen.value = false;
  }
}

watch(menuOpen, (open) => {
  if (open) document.addEventListener('pointerdown', onDocumentPointerDown, true);
  else document.removeEventListener('pointerdown', onDocumentPointerDown, true);
});

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocumentPointerDown, true);
});
</script>

<template>
  <div class="mixer-panel">
    <div class="mixer-toolbar">
      <span class="mixer-title">{{ t.shell.mixer.title }}</span>
      <span v-if="hiddenCount > 0" class="mixer-hidden-note">
        {{ formatMessage(t.shell.mixer.hiddenCount, { count: String(hiddenCount) }) }}
      </span>
      <span class="toolbar-spacer" />
      <MixerSnapshots />
      <button
        type="button"
        class="toolbar-button"
        :title="t.shell.mixer.addBusTitle"
        @click="onAddBus"
      >
        {{ t.shell.mixer.addBus }}
      </button>
      <button
        type="button"
        class="toolbar-button"
        :title="t.shell.mixer.addVcaTitle"
        :disabled="!canAddVca"
        @click="onAddVca"
      >
        {{ t.shell.mixer.addVca }}
      </button>
      <div ref="menuEl" class="view-menu-wrap">
        <button
          type="button"
          class="toolbar-button"
          :title="t.shell.mixer.viewTitle"
          aria-haspopup="menu"
          :aria-expanded="menuOpen"
          @click="menuOpen = !menuOpen"
        >
          {{ t.shell.mixer.view }} ▾
        </button>
        <div v-if="menuOpen" class="view-menu" role="menu">
          <div class="view-menu-section">{{ t.shell.mixer.tracks }}</div>
          <label v-for="track in store.tracks" :key="track.id" class="view-menu-track">
            <input
              type="checkbox"
              :checked="!hiddenTrackIds.has(track.id)"
              @change="toggleTrackVisible(track.id)"
            />
            <span class="view-menu-swatch" :style="{ background: track.color }" />
            <span class="view-menu-name">{{ track.name }}</span>
          </label>
          <button
            v-if="hiddenCount > 0"
            type="button"
            role="menuitem"
            class="view-menu-action"
            @click="showAllTracks"
          >
            {{ t.shell.mixer.showAll }}
          </button>
        </div>
      </div>
    </div>
    <p v-if="error" class="mixer-error" role="alert">{{ error }}</p>
    <div class="mixer-strips">
      <TransitionGroup tag="div" name="strip" class="strip-flow">
        <ChannelStrip
          v-for="track in visibleTracks"
          :key="track.id"
          :target="track.id"
          :bridge="props.meterFor ? props.meterFor(track.id) : null"
          :scope="props.scopeFor ? props.scopeFor(track.id) : null"
          :position-ppq="props.positionPpq"
          :is-playing="props.isPlaying"
        />
        <BusStrip
          v-for="bus in store.mixer.buses"
          :key="bus.id"
          :bus="bus"
          :bridge="props.busMeterFor ? props.busMeterFor(bus.id) : null"
          :position-ppq="props.positionPpq"
          :is-playing="props.isPlaying"
        />
        <VcaStrip v-for="group in store.mixer.vcaGroups ?? []" :key="group.id" :group="group" />
      </TransitionGroup>
      <div class="strips-spacer" />
      <ChannelStrip
        class="master-strip"
        target="master"
        :bridge="props.bridge"
        :analyser="props.analyser"
        :scope="props.masterScope"
        :position-ppq="props.positionPpq"
        :is-playing="props.isPlaying"
      />
    </div>
  </div>
</template>

<style scoped>
.mixer-panel {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-height: 0;
  background: var(--surface-2);
  overflow: hidden;
}

.mixer-toolbar {
  display: flex;
  align-items: center;
  gap: var(--sp-4);
  padding: 3px var(--sp-4);
  border-bottom: 1px solid var(--border-strong);
  flex: none;
  box-shadow: var(--raise-hi);
}

.mixer-title {
  font: var(--fw-bold) 9px var(--font-sans);
  letter-spacing: 0.08em;
  color: var(--text-4);
  user-select: none;
}

.mixer-hidden-note {
  font: 9px var(--font-sans);
  color: var(--text-4);
}

.toolbar-spacer {
  flex: 1;
}

.view-menu-wrap {
  position: relative;
}

.toolbar-button {
  font: var(--fw-semibold) 10px var(--font-sans);
  color: var(--text-2);
  background: var(--surface-3);
  border-radius: var(--radius-sm);
  padding: 2px var(--sp-4);
  cursor: pointer;
  box-shadow: var(--control-lift);
  transition: background var(--dur-1) var(--ease-out);
}

.toolbar-button:hover {
  background: var(--surface-4);
  box-shadow: var(--control-lift-hover);
}

.view-menu {
  position: absolute;
  top: calc(100% + 2px);
  right: 0;
  z-index: 40;
  min-width: 160px;
  max-height: 280px;
  overflow-y: auto;
  background: var(--surface-3);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow-pop);
  padding: 2px 0;
}

.view-menu-section {
  font: var(--fw-bold) 8px var(--font-sans);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-4);
  padding: 5px 10px 2px;
}

.view-menu-track {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 2px 10px;
  font: 10px var(--font-sans);
  color: var(--text-2);
  cursor: pointer;
  transition: background var(--dur-1) var(--ease-out);
}

.view-menu-track:hover {
  background: var(--surface-4);
}

.view-menu-swatch {
  width: 8px;
  height: 8px;
  border-radius: 2px;
  flex: none;
}

.view-menu-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.view-menu-action {
  display: block;
  width: 100%;
  text-align: left;
  font: var(--fw-semibold) 10px var(--font-sans);
  color: #9fc4f5;
  background: transparent;
  border: none;
  box-shadow: none;
  padding: 3px 10px;
  cursor: pointer;
}

.view-menu-action:hover {
  background: var(--surface-4);
}

.mixer-error {
  margin: 0;
  padding: 2px var(--sp-4);
  background: var(--danger-surface);
  color: var(--danger-text);
  font: 10px/1.4 var(--font-sans);
  flex: none;
}

.mixer-strips {
  display: flex;
  align-items: stretch;
  flex: 1;
  min-height: 0;
  overflow-x: auto;
  overflow-y: auto;
}

/* Holds just the dynamic track/bus/VCA strips so add/remove can animate
 * without touching the spacer or the sticky master strip outside it.
 * position:relative anchors a leaving strip's absolute leave transition. */
.strip-flow {
  display: flex;
  align-items: stretch;
  flex: none;
  position: relative;
}

.strips-spacer {
  flex: 1;
  min-width: var(--sp-4);
}

.master-strip {
  position: sticky;
  right: 0;
  z-index: 20;
  box-shadow: -4px 0 8px rgba(0, 0, 0, 0.35);
}
</style>

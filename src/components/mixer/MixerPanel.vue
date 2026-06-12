<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import type { MeterSource } from '@/engine/meters';
import { addMixerBus, removeMixerBus } from '@/project/commands';
import { useProjectStore } from '@/project/store';
import type { EditorTrack } from '@/project/types';
import ChannelStrip from './ChannelStrip.vue';

/**
 * Mixer panel for the editor dock: a horizontal scroll of channel strips
 * (one per project track, in track order) with the master strip pinned at
 * the right. Tracks can be hidden from the mixer view via the visibility
 * menu — that state is panel-local and does not touch the project. Send
 * buses are managed from the same menu (buses are routing metadata only in
 * this iteration).
 *
 * The master strip is fed by the summed-output meter source; track strips
 * are fed per track via the meterFor lookup (the engine publishes a meter
 * record per mixer lane). Strips without a source show a placeholder meter.
 */

const props = withDefaults(
  defineProps<{
    /** Engine meter source for the master strip; null draws silent meters. */
    bridge?: MeterSource | null;
    /** Per-track meter source lookup; null shows placeholder track meters. */
    meterFor?: ((trackId: number) => MeterSource | null) | null;
  }>(),
  { bridge: null, meterFor: null },
);

const store = useProjectStore();

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

function onRemoveBus(busId: string): void {
  try {
    removeMixerBus(busId);
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
      <span class="mixer-title">MIXER</span>
      <span v-if="hiddenCount > 0" class="mixer-hidden-note">
        {{ hiddenCount }} hidden
      </span>
      <span class="toolbar-spacer" />
      <div ref="menuEl" class="view-menu-wrap">
        <button
          type="button"
          class="toolbar-button"
          title="Mixer view options"
          aria-haspopup="menu"
          :aria-expanded="menuOpen"
          @click="menuOpen = !menuOpen"
        >
          View ▾
        </button>
        <div v-if="menuOpen" class="view-menu" role="menu">
          <div class="view-menu-section">Tracks</div>
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
            Show all
          </button>
          <div class="view-menu-section">Buses</div>
          <div v-for="bus in store.mixer.buses" :key="bus.id" class="view-menu-bus">
            <span class="view-menu-name">{{ bus.name }}</span>
            <button
              type="button"
              class="view-menu-bus-remove"
              title="Remove bus (and its sends)"
              :aria-label="`Remove bus ${bus.name}`"
              @click="onRemoveBus(bus.id)"
            >
              ×
            </button>
          </div>
          <button type="button" role="menuitem" class="view-menu-action" @click="onAddBus">
            + Bus
          </button>
        </div>
      </div>
    </div>
    <p v-if="error" class="mixer-error" role="alert">{{ error }}</p>
    <div class="mixer-strips">
      <ChannelStrip
        v-for="track in visibleTracks"
        :key="track.id"
        :target="track.id"
        :bridge="props.meterFor ? props.meterFor(track.id) : null"
      />
      <div class="strips-spacer" />
      <ChannelStrip class="master-strip" target="master" :bridge="props.bridge" />
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
  background: #14161b;
  overflow: hidden;
}

.mixer-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 8px;
  border-bottom: 1px solid rgba(0, 0, 0, 0.5);
  flex: none;
}

.mixer-title {
  font: 700 9px system-ui, sans-serif;
  letter-spacing: 0.08em;
  color: #5b6270;
  user-select: none;
}

.mixer-hidden-note {
  font: 9px system-ui, sans-serif;
  color: #5b6270;
}

.toolbar-spacer {
  flex: 1;
}

.view-menu-wrap {
  position: relative;
}

.toolbar-button {
  font: 600 10px system-ui, sans-serif;
  color: #c8cdd6;
  background: #1d2027;
  border: 1px solid #2a2e37;
  border-radius: 4px;
  padding: 2px 8px;
  cursor: pointer;
}

.toolbar-button:hover {
  background: #242832;
}

.view-menu {
  position: absolute;
  top: calc(100% + 2px);
  right: 0;
  z-index: 40;
  min-width: 160px;
  max-height: 280px;
  overflow-y: auto;
  background: #1d2027;
  border: 1px solid #2a2e37;
  border-radius: 4px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.45);
  padding: 2px 0;
}

.view-menu-section {
  font: 700 8px system-ui, sans-serif;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: #5b6270;
  padding: 5px 10px 2px;
}

.view-menu-track {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 2px 10px;
  font: 10px system-ui, sans-serif;
  color: #c8cdd6;
  cursor: pointer;
}

.view-menu-track:hover {
  background: #242832;
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

.view-menu-bus {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 2px 10px;
  font: 10px system-ui, sans-serif;
  color: #c8cdd6;
}

.view-menu-bus-remove {
  flex: none;
  border: none;
  background: transparent;
  color: #5b6270;
  font: 11px system-ui, sans-serif;
  line-height: 1;
  padding: 0 1px;
  cursor: pointer;
}

.view-menu-bus-remove:hover {
  color: #ffb4b4;
}

.view-menu-action {
  display: block;
  width: 100%;
  text-align: left;
  font: 600 10px system-ui, sans-serif;
  color: #9fc4f5;
  background: transparent;
  border: none;
  padding: 3px 10px;
  cursor: pointer;
}

.view-menu-action:hover {
  background: #242832;
}

.mixer-error {
  margin: 0;
  padding: 2px 8px;
  background: #3b1219;
  color: #ffb4b4;
  font: 10px/1.4 system-ui, sans-serif;
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

.strips-spacer {
  flex: 1;
  min-width: 8px;
}

.master-strip {
  position: sticky;
  right: 0;
  z-index: 20;
  box-shadow: -4px 0 8px rgba(0, 0, 0, 0.35);
}
</style>

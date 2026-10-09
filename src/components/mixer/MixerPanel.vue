<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import SelectMenu from '@/components/shell/SelectMenu.vue';
import { useAppSettings } from '@/composables/useAppSettings';
import type { AnalyserBridge } from '@/engine/analyser';
import type { MeterSource } from '@/engine/meters';
import type { ScopeSource } from '@/engine/scope';
import type { AutomationParam, AutomationTarget } from '@/project/automation';
import {
  addMixerBus,
  addVcaGroup,
  applyMixerSceneJson,
  clearAllSolo,
  setMixerSoloMode,
} from '@/project/commands';
import { MAX_VCA_GROUPS, type MixerSoloMode, normalizeMixerSoloMode } from '@/project/mixer';
import { useProjectStore } from '@/project/store';
import type { EditorTrack } from '@/project/types';
import { formatMessage, useI18n } from '@/ui/i18n';
import type { AutomationWriteScheduleEvent } from '@/ui/mixer/automation-mode';
import {
  humanizeMixerScenePreset,
  loadMixerScenePresetCatalog,
  loadMixerScenePresetJson,
} from '@/ui/mixer/scene-presets';
import type { SidechainRefusalLookup } from '@/ui/mixer/sidechain-refusal';
import BusStrip from './BusStrip.vue';
import ChannelStrip from './ChannelStrip.vue';
import MixerSnapshots from './MixerSnapshots.vue';
import MixSuggestDialog from './MixSuggestDialog.vue';
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
    /** Engine sidechain refusal lookup for insert key pickers; null without an engine. */
    sidechainRefusal?: SidechainRefusalLookup | null;
    /** Per-track scope source lookup (engine spectrum + goniometer). */
    scopeFor?: ((trackId: number) => ScopeSource | null) | null;
    /** Per-bus scope source lookup (engine spectrum + goniometer). */
    busScopeFor?: ((busId: string) => ScopeSource | null) | null;
    /** Playhead position getter in PPQ (strip automation follow/recording). */
    positionPpq?: () => number;
    /** Current playhead sample position, used by future sample-accurate scheduling. */
    positionSample?: () => number;
    /** True while the transport runs (strip automation touch recording). */
    isPlaying?: boolean;
    /** Whether this v-show-backed dock panel is currently visible. */
    visible?: boolean;
    /** Transport loop, the range a mix suggestion is measured over when active. */
    loopEnabled?: boolean;
    loopStartPpq?: number;
    loopEndPpq?: number;
    /** Optional realtime automation scheduler for write-mode strip drags. */
    scheduleAutomationWrite?: (
      target: AutomationTarget,
      param: AutomationParam,
      event: AutomationWriteScheduleEvent,
    ) => void;
  }>(),
  {
    bridge: null,
    analyser: null,
    masterScope: null,
    meterFor: null,
    busMeterFor: null,
    sidechainRefusal: null,
    scopeFor: null,
    busScopeFor: null,
    positionPpq: undefined,
    positionSample: undefined,
    isPlaying: false,
    visible: true,
  },
);

const store = useProjectStore();
const appSettings = useAppSettings();

/** A group track's inserts run on its group bus, so read their gain reduction there. */
function insertMeterFor(track: EditorTrack): MeterSource | null {
  if (track.kind !== 'group') return null;
  return props.busMeterFor ? props.busMeterFor(`group:${track.id}`) : null;
}
const { t } = useI18n();

/** Track ids hidden from the mixer view (persisted as a user layout preference). */
const hiddenTrackIds = computed(() => new Set(appSettings.settings.mixerHiddenTrackIds));

const visibleTracks = computed<EditorTrack[]>(() =>
  store.tracks.filter((track) => !hiddenTrackIds.value.has(track.id)),
);

const hiddenCount = computed(() => store.tracks.length - visibleTracks.value.length);

const soloMode = computed<MixerSoloMode>({
  get: () => normalizeMixerSoloMode(store.mixer.soloMode),
  set: (mode) => setMixerSoloMode(mode),
});

const soloModeOptions = computed(() => [
  { value: 'inPlace', label: t.value.shell.mixer.soloMode.inPlace },
  { value: 'pfl', label: t.value.shell.mixer.soloMode.pfl },
]);

const hasSolo = computed(
  () =>
    store.tracks.some((track) => track.solo) ||
    (store.mixer.vcaGroups ?? []).some((g) => g.solo) ||
    store.mixer.buses.some((bus) => bus.solo === true),
);

function toggleTrackVisible(trackId: number): void {
  const next = new Set(hiddenTrackIds.value);
  if (next.has(trackId)) next.delete(trackId);
  else next.add(trackId);
  appSettings.set('mixerHiddenTrackIds', [...next]);
}

function showAllTracks(): void {
  appSettings.set('mixerHiddenTrackIds', []);
}

// --- View menu (visibility + buses) -------------------------------------------

const menuOpen = ref(false);
const menuEl = ref<HTMLDivElement | null>(null);
const sceneMenuOpen = ref(false);
const sceneMenuEl = ref<HTMLDivElement | null>(null);
const sceneCatalog = ref<string[]>([]);

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

function toggleSceneMenu(): void {
  if (!sceneMenuOpen.value) sceneCatalog.value = loadMixerScenePresetCatalog();
  sceneMenuOpen.value = !sceneMenuOpen.value;
}

/** Whether the mix-suggestion dialog is open. */
const suggestMixOpen = ref(false);

function openSuggestMix(): void {
  sceneMenuOpen.value = false;
  suggestMixOpen.value = true;
}

function onApplyScenePreset(preset: string): void {
  try {
    applyMixerSceneJson(loadMixerScenePresetJson(preset));
    sceneMenuOpen.value = false;
    error.value = '';
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

function onDocumentPointerDown(event: PointerEvent): void {
  if (!(event.target instanceof Node)) {
    menuOpen.value = false;
    sceneMenuOpen.value = false;
    return;
  }
  if (!menuEl.value?.contains(event.target)) {
    menuOpen.value = false;
  }
  if (!sceneMenuEl.value?.contains(event.target)) {
    sceneMenuOpen.value = false;
  }
}

watch([menuOpen, sceneMenuOpen], ([viewOpen, scenesOpen]) => {
  if (viewOpen || scenesOpen) document.addEventListener('pointerdown', onDocumentPointerDown, true);
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
        v-if="hasSolo"
        type="button"
        class="toolbar-button solo-clear"
        v-tooltip="t.shell.mixer.clearSolo"
        @click="clearAllSolo"
      >
        {{ t.shell.mixer.clearSolo }}
      </button>
      <SelectMenu
        v-model="soloMode"
        class="solo-mode-select"
        size="sm"
        :options="soloModeOptions"
        :aria-label="t.shell.mixer.soloMode.title"
        :title="t.shell.mixer.soloMode.title"
      />
      <div ref="sceneMenuEl" class="view-menu-wrap">
        <button
          type="button"
          class="toolbar-button"
          v-tooltip="t.shell.mixer.scenes.title"
          aria-haspopup="menu"
          :aria-expanded="sceneMenuOpen"
          @click="toggleSceneMenu"
        >
          {{ t.shell.mixer.scenes.button }} ▾
        </button>
        <div v-if="sceneMenuOpen" class="view-menu scene-menu" role="menu">
          <div class="view-menu-section">{{ t.shell.mixer.scenes.title }}</div>
          <button
            v-for="preset in sceneCatalog"
            :key="preset"
            type="button"
            role="menuitem"
            class="view-menu-action"
            @click="onApplyScenePreset(preset)"
          >
            {{ humanizeMixerScenePreset(preset) }}
          </button>
          <div class="view-menu-separator" role="separator" />
          <button type="button" role="menuitem" class="view-menu-action" @click="openSuggestMix">
            {{ t.shell.mixer.scenes.suggest }}
          </button>
        </div>
      </div>
      <button
        type="button"
        class="toolbar-button"
        v-tooltip="t.shell.mixer.addBusTitle"
        @click="onAddBus"
      >
        {{ t.shell.mixer.addBus }}
      </button>
      <button
        type="button"
        class="toolbar-button"
        v-tooltip="t.shell.mixer.addVcaTitle"
        :disabled="!canAddVca"
        @click="onAddVca"
      >
        {{ t.shell.mixer.addVca }}
      </button>
      <div ref="menuEl" class="view-menu-wrap">
        <button
          type="button"
          class="toolbar-button"
          v-tooltip="t.shell.mixer.viewTitle"
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
          :insert-meter="insertMeterFor(track)"
          :sidechain-refusal="props.sidechainRefusal"
          :scope="props.scopeFor ? props.scopeFor(track.id) : null"
          :position-ppq="props.positionPpq"
          :position-sample="props.positionSample"
          :is-playing="props.isPlaying"
          :visible="props.visible"
          :schedule-automation-write="props.scheduleAutomationWrite"
        />
        <BusStrip
          v-for="bus in store.mixer.buses"
          :key="bus.id"
          :bus="bus"
          :bridge="props.busMeterFor ? props.busMeterFor(bus.id) : null"
          :sidechain-refusal="props.sidechainRefusal"
          :scope="props.busScopeFor ? props.busScopeFor(bus.id) : null"
          :position-ppq="props.positionPpq"
          :position-sample="props.positionSample"
          :is-playing="props.isPlaying"
          :visible="props.visible"
          :schedule-automation-write="props.scheduleAutomationWrite"
        />
        <VcaStrip v-for="group in store.mixer.vcaGroups ?? []" :key="group.id" :group="group" />
      </TransitionGroup>
      <div class="strips-spacer" />
      <ChannelStrip
        class="master-strip"
        target="master"
        :bridge="props.bridge"
        :sidechain-refusal="props.sidechainRefusal"
        :analyser="props.analyser"
        :scope="props.masterScope"
        :position-ppq="props.positionPpq"
        :position-sample="props.positionSample"
        :is-playing="props.isPlaying"
        :visible="props.visible"
        :schedule-automation-write="props.scheduleAutomationWrite"
      />
    </div>
    <MixSuggestDialog
      :open="suggestMixOpen"
      :loop-enabled="props.loopEnabled ?? false"
      :loop-start-ppq="props.loopStartPpq ?? 0"
      :loop-end-ppq="props.loopEndPpq ?? 0"
      @close="suggestMixOpen = false"
    />
  </div>
</template>

<style scoped>
.mixer-panel {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-height: 0;
  background: var(--surface-panel);
  overflow: hidden;
}

.mixer-toolbar {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  padding: 3px var(--sp-4);
  background: var(--surface-toolbar);
  border-bottom: 1px solid var(--border);
  flex: none;
  overflow-x: auto;
  scrollbar-width: none;
}

.mixer-toolbar::-webkit-scrollbar {
  display: none;
}

.mixer-title {
  font: var(--fw-bold) var(--fs-2xs) var(--font-sans);
  letter-spacing: 0.08em;
  color: var(--text-1);
  user-select: none;
}

.mixer-hidden-note {
  font: var(--fs-chrome-lg) var(--font-sans);
  color: var(--text-3);
}

.toolbar-spacer {
  flex: 1;
}

.view-menu-wrap {
  position: relative;
}

/* The solo-mode select defaults to width:100% (SelectMenu baseline); in the
   flex toolbar that stretches it across the row and squeezes the trailing
   buttons. Size it to its content instead so the buttons keep their width. */
.mixer-toolbar .solo-mode-select {
  width: auto;
  flex: none;
}

.toolbar-button {
  font: var(--fw-semibold) var(--fs-2xs) var(--font-sans);
  color: var(--text-3);
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  padding: 2px var(--sp-4);
  cursor: pointer;
  box-shadow: none;
  transition:
    background var(--dur-1) var(--ease-out),
    border-color var(--dur-1) var(--ease-out),
    color var(--dur-1) var(--ease-out);
  /* Toolbar labels (incl. CJK) must never wrap or shrink to a narrower box. */
  white-space: nowrap;
  flex: none;
}

.toolbar-button:hover {
  color: var(--text-1);
  background: var(--surface-selection);
  border-color: var(--accent-muted);
  box-shadow: none;
}

.toolbar-button:active {
  color: var(--accent);
  background: var(--accent-soft);
  border-color: var(--accent-muted);
}

.toolbar-button:focus-visible {
  outline: 2px solid transparent;
  outline-offset: 1px;
  box-shadow: var(--ring);
}

.toolbar-button:disabled {
  color: var(--text-4);
  opacity: 0.65;
  cursor: default;
}

.toolbar-button.solo-clear {
  color: var(--danger-text);
}

.toolbar-button.solo-clear:hover {
  color: var(--danger-text);
  background: var(--danger-surface);
  border-color: var(--danger-text);
}

.view-menu {
  position: absolute;
  top: calc(100% + 2px);
  right: 0;
  z-index: 40;
  min-width: 160px;
  max-height: 280px;
  overflow-y: auto;
  background: var(--surface-floating);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow-pop);
  padding: 2px 0;
}

.view-menu-separator {
  height: 1px;
  margin: 4px 0;
  background: var(--border);
}

.view-menu-section {
  font: var(--fw-bold) var(--fs-chrome-md) var(--font-sans);
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
  font: var(--fs-2xs) var(--font-sans);
  color: var(--text-2);
  cursor: pointer;
  transition: background var(--dur-1) var(--ease-out);
}

.view-menu-track:hover {
  background: var(--surface-selection);
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
  font: var(--fw-semibold) var(--fs-2xs) var(--font-sans);
  color: var(--accent);
  background: transparent;
  border: none;
  box-shadow: none;
  padding: 3px 10px;
  cursor: pointer;
}

.view-menu-action:hover {
  background: var(--surface-selection);
}

.view-menu-action:focus-visible {
  outline: 2px solid transparent;
  outline-offset: -1px;
  box-shadow: var(--ring);
}

.mixer-error {
  margin: 0;
  padding: 2px var(--sp-4);
  background: var(--danger-surface);
  color: var(--danger-text);
  font: var(--fs-2xs)/1.4 var(--font-sans);
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
  box-shadow: none;
}
</style>

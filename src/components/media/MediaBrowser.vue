<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import BusyIndicator from '@/components/shell/BusyIndicator.vue';
import EmptyState from '@/components/shell/EmptyState.vue';
import SearchField from '@/components/shell/SearchField.vue';
import SelectMenu from '@/components/shell/SelectMenu.vue';
import ToggleButton from '@/components/shell/ToggleButton.vue';
import { errorMessage } from '@/lib/errors';
import { ensureWasm } from '@/lib/wasm';
import { deleteAudioAssetGuarded } from '@/persistence/asset-leases';
import { type AudioAssetMeta, listAssets, loadAsset } from '@/persistence/assets';
import { collectReferencedMediaIds } from '@/persistence/gc';
import { isOpfsAvailable } from '@/persistence/opfs';
import { decodeAndIngest } from '@/project/audio-import';
import { collectHistoryReferencedMediaIds } from '@/project/commands';
import { useProjectStore } from '@/project/store';
import { firstBlock } from '@/ui/disabled-reason';
import { formatMessage, useI18n } from '@/ui/i18n';
import { setAssetDragData } from '@/ui/media/asset-drag';
import {
  type AssetSortKey,
  assetDurationSeconds,
  collectKeyTags,
  filterAssets,
  formatBpm,
  formatChannels,
  formatDuration,
  formatLufs,
  formatSampleRate,
  parseBpmRange,
  referencedAssetIds,
  sortAssets,
} from '@/ui/media/asset-list';
import {
  createAudioPreview,
  DEFAULT_PREVIEW_GAIN,
  type PreviewContextFactory,
  previewStretchRate,
  stretchChannels,
  type TimeStretchFunction,
} from '@/ui/media/preview';

/**
 * Media browser panel: lists the stored audio assets with filtering, sorting,
 * import (file picker or drag-and-drop), decode-free preview playback and
 * deletion. "Add" emits `add-to-project` with the asset id — the shell
 * decides target track and position. Rows are draggable and carry the asset
 * id under the `application/x-sonare-asset` MIME type (see
 * src/ui/media/asset-drag.ts) for future arrangement drop targets.
 *
 * Preview plays the stored channels through a plain AudioBufferSourceNode on
 * a lazily-created AudioContext, independent of the engine; it never makes
 * the engine itself audible.
 */

const props = withDefaults(
  defineProps<{
    /** True while the browser panel is visible; refreshes the list when shown. */
    visible?: boolean;
    /**
     * Factory for the preview AudioContext (created lazily on first play).
     * Defaults to `() => new AudioContext()`; injectable for tests.
     */
    previewContextFactory?: PreviewContextFactory;
  }>(),
  { visible: true },
);

const emit = defineEmits<{
  /** The user asked to add this asset to the project. */
  'add-to-project': [assetId: string];
}>();

const store = useProjectStore();
const { t } = useI18n();

// --- Asset listing ---------------------------------------------------------

const assets = ref<AudioAssetMeta[]>([]);
const listError = ref<string | null>(null);
const loaded = ref(false);

/** Reloads the asset list from the store. */
async function refresh(): Promise<void> {
  try {
    assets.value = await listAssets();
    listError.value = null;
  } catch (error) {
    listError.value = errorMessage(error);
  } finally {
    loaded.value = true;
  }
}

// --- Filtering and sorting -------------------------------------------------

const filterText = ref('');
const filterKey = ref('');
const bpmText = ref('');
const sortKey = ref<AssetSortKey>('name');

const bpmRange = computed(() => parseBpmRange(bpmText.value));
const bpmInvalid = computed(() => bpmText.value.trim().length > 0 && bpmRange.value === null);
const keyOptions = computed(() => collectKeyTags(assets.value));

/** Key filter choices: "Any key" plus each distinct key tag in the assets. */
const keyFilterOptions = computed(() => [
  { value: '', label: t.value.shell.media.anyKey },
  ...keyOptions.value.map((key) => ({ value: key, label: key })),
]);

/** Sort-order choices for the asset list. */
const sortOptions = computed<ReadonlyArray<{ value: AssetSortKey; label: string }>>(() => [
  { value: 'name', label: t.value.shell.media.sortName },
  { value: 'duration', label: t.value.shell.media.sortDuration },
  { value: 'bpm', label: t.value.shell.media.sortBpm },
  { value: 'loudness', label: t.value.shell.media.sortLoudness },
]);
const displayedAssets = computed(() =>
  sortAssets(
    filterAssets(assets.value, {
      text: filterText.value,
      key: filterKey.value || undefined,
      bpm: bpmRange.value,
    }),
    sortKey.value,
  ),
);

/** Asset ids referenced by clips, comp takes or frozen tracks; deletion is blocked. */
const referencedIds = computed(() => referencedAssetIds(store.clips, store.tracks));

/**
 * Asset ids that deletion must not touch, resolved once per change so list
 * rows share the lookup. Actions re-check through {@link isReferenced}.
 */
const blockedIds = computed(
  () => new Set([...referencedIds.value, ...collectHistoryReferencedMediaIds().assetIds]),
);

/** Why an asset cannot be deleted: clips still play it. */
function deleteBlocked(assetId: string): string | null {
  return firstBlock([blockedIds.value.has(assetId), t.value.shell.media.deleteBlocked]);
}

/** Includes snapshots reachable through undo/redo, not only the live mirror. */
function isReferenced(assetId: string): boolean {
  return (
    referencedIds.value.has(assetId) || collectHistoryReferencedMediaIds().assetIds.has(assetId)
  );
}

function protectedAssetIds(): Set<string> {
  return new Set([...referencedIds.value, ...collectHistoryReferencedMediaIds().assetIds]);
}

// --- Import ----------------------------------------------------------------

const fileInput = ref<HTMLInputElement | null>(null);
/** Files finished, and the share of the current file's tag analysis done. */
const importProgress = ref<{ done: number; total: number; current: number } | null>(null);
const importBlocked = computed(() =>
  firstBlock([importProgress.value !== null, t.value.shell.media.reasons.importing]),
);
// Filters and sorting have nothing to act on until the library holds an asset.
const filterBlocked = computed(() =>
  firstBlock([loaded.value && assets.value.length === 0, t.value.shell.media.reasons.noAssets]),
);
const importErrors = ref<Array<{ name: string; message: string }>>([]);
const dragOver = ref(false);

/** Imports the picked/dropped files one by one, collecting per-file errors. */
async function importFiles(files: ReadonlyArray<File>): Promise<void> {
  if (files.length === 0 || importProgress.value) return;
  importErrors.value = [];
  importProgress.value = { done: 0, total: files.length, current: 0 };
  for (const file of files) {
    try {
      await decodeAndIngest(file, {
        onProgress: (fraction) => {
          if (importProgress.value)
            importProgress.value = { ...importProgress.value, current: fraction };
        },
      });
    } catch (error) {
      importErrors.value = [
        ...importErrors.value,
        { name: file.name, message: errorMessage(error) },
      ];
    }
    importProgress.value = { done: importProgress.value.done + 1, total: files.length, current: 0 };
  }
  importProgress.value = null;
  await refresh();
}

function onImportClick(): void {
  fileInput.value?.click();
}

function onFileInputChange(event: Event): void {
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  input.value = '';
  void importFiles(files);
}

/** True when a drag carries OS files (as opposed to in-app asset rows). */
function isFileDrag(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes('Files');
}

function onDragOver(event: DragEvent): void {
  if (!isFileDrag(event)) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  dragOver.value = true;
}

function onDragLeave(): void {
  dragOver.value = false;
}

function onDrop(event: DragEvent): void {
  if (!isFileDrag(event)) return;
  event.preventDefault();
  dragOver.value = false;
  const files = Array.from(event.dataTransfer?.files ?? []);
  void importFiles(files);
}

// --- Preview ---------------------------------------------------------------

const playingId = ref<string | null>(null);
const previewError = ref<string | null>(null);
/** Asset whose preview buffer is still being read/stretched. */
const previewLoadingId = ref<string | null>(null);
const syncToTempo = ref(false);
const timeStretchFn = shallowRef<TimeStretchFunction | null>(null);
let disposed = false;
let previewGeneration = 0;

const preview = createAudioPreview({
  contextFactory: props.previewContextFactory,
  gain: DEFAULT_PREVIEW_GAIN,
  onChange: (id) => {
    playingId.value = id;
  },
});

/** Starts or stops decode-free preview playback of an asset. */
async function togglePreview(asset: AudioAssetMeta): Promise<void> {
  if (playingId.value === asset.id) {
    previewGeneration++;
    preview.stop();
    return;
  }
  previewError.value = null;
  const generation = ++previewGeneration;
  previewLoadingId.value = asset.id;
  try {
    const loadedAsset = await loadAsset(asset.id);
    if (disposed || generation !== previewGeneration) return;
    let channels: ReadonlyArray<Float32Array> = loadedAsset.channels;
    const stretch = timeStretchFn.value;
    const assetBpm = asset.tags?.bpm;
    if (syncToTempo.value && stretch && assetBpm !== undefined) {
      const rate = previewStretchRate(assetBpm, store.tempoBpm);
      if (rate !== null) {
        channels = stretchChannels(stretch, channels, loadedAsset.meta.sampleRate, rate);
      }
    }
    preview.play(asset.id, { channels, sampleRate: loadedAsset.meta.sampleRate });
  } catch (error) {
    if (disposed || generation !== previewGeneration) return;
    previewError.value = errorMessage(error);
  } finally {
    if (previewLoadingId.value === asset.id) previewLoadingId.value = null;
  }
}

// --- Deletion --------------------------------------------------------------

const pendingDeleteId = ref<string | null>(null);
const deleteError = ref<string | null>(null);

function requestDelete(assetId: string): void {
  if (isReferenced(assetId)) return;
  deleteError.value = null;
  pendingDeleteId.value = assetId;
}

function cancelDelete(): void {
  pendingDeleteId.value = null;
}

async function confirmDelete(assetId: string): Promise<void> {
  pendingDeleteId.value = null;
  // Re-check: a clip may have started referencing the asset meanwhile.
  if (isReferenced(assetId)) {
    deleteError.value = t.value.shell.media.deleteBlocked;
    return;
  }
  if (playingId.value === assetId) preview.stop();
  try {
    const deleted = await deleteAudioAssetGuarded(assetId, async () => {
      if (isReferenced(assetId)) return true;
      // The media store is shared by every project. Re-scan saved documents at
      // the mutation boundary so a project saved after confirmation cannot
      // lose its source asset. The live document's refs are folded in through
      // the current strip snapshot.
      if (!isOpfsAvailable()) return false;
      const references = await collectReferencedMediaIds(undefined, {
        assetIds: protectedAssetIds(),
      });
      return !references.complete || references.assetIds.has(assetId) || isReferenced(assetId);
    });
    if (!deleted) {
      deleteError.value = isReferenced(assetId)
        ? t.value.shell.media.deleteBlocked
        : t.value.shell.media.deleteInUse;
    }
  } catch (error) {
    deleteError.value = errorMessage(error);
  }
  await refresh();
}

// --- Row actions -----------------------------------------------------------

function onAdd(assetId: string): void {
  emit('add-to-project', assetId);
}

function onRowDragStart(event: DragEvent, assetId: string): void {
  if (!event.dataTransfer) return;
  setAssetDragData(event.dataTransfer, assetId);
}

function formatTagNumber(value: number, digits = 1): string {
  return value.toFixed(digits);
}

/** One-line metadata summary shown under the asset name. */
function assetSummary(asset: AudioAssetMeta): string {
  const parts = [
    formatDuration(assetDurationSeconds(asset)),
    formatChannels(asset.numChannels),
    formatSampleRate(asset.sampleRate),
  ];
  if (asset.tags?.bpm !== undefined) parts.push(`${formatBpm(asset.tags.bpm)} BPM`);
  if (asset.tags?.key) parts.push(asset.tags.key);
  if (asset.tags?.timeSignature) parts.push(asset.tags.timeSignature);
  if (asset.tags?.grooveType) parts.push(asset.tags.grooveType);
  if (asset.tags?.dynamicRangeDb !== undefined)
    parts.push(`DR ${formatTagNumber(asset.tags.dynamicRangeDb)} dB`);
  if (asset.tags?.brightness !== undefined)
    parts.push(`Bright ${formatTagNumber(asset.tags.brightness, 2)}`);
  if (asset.tags?.lufs !== undefined) parts.push(formatLufs(asset.tags.lufs));
  return parts.join(' · ');
}

onMounted(() => {
  void refresh();
  // Probe the optional one-shot time stretcher; tempo-synced preview is
  // silently unavailable when the module does not expose it.
  void ensureWasm()
    .then((mod) => {
      if (disposed) return;
      const fn = (mod as { timeStretch?: unknown }).timeStretch;
      if (typeof fn === 'function') timeStretchFn.value = fn as TimeStretchFunction;
    })
    .catch(() => {
      // No wasm module: previews still work, just without tempo sync.
    });
});

watch(
  () => props.visible,
  (visible, wasVisible) => {
    if (visible && wasVisible === false) void refresh();
  },
);

onBeforeUnmount(() => {
  disposed = true;
  previewGeneration++;
  preview.dispose();
});
</script>

<template>
  <section
    class="media-browser"
    :class="{ 'drag-over': dragOver }"
    :aria-label="t.shell.media.label"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
  >
    <div class="toolbar">
      <SearchField
        v-model="filterText"
        class="filter-text"
        :placeholder="t.shell.media.filterByName"
        :aria-label="t.shell.media.filterAssetsByName"
        :disabled="!!filterBlocked"
        v-tooltip="{ reason: filterBlocked }"
      />
      <SelectMenu
        v-model="filterKey"
        :options="keyFilterOptions"
        class="filter-key"
        :aria-label="t.shell.media.filterByKey"
        :reason="filterBlocked"
        size="sm"
      />
      <input
        v-model="bpmText"
        class="filter-bpm"
        :class="{ invalid: bpmInvalid }"
        type="text"
        :placeholder="t.shell.media.bpmPlaceholder"
        :aria-label="t.shell.media.filterByBpm"
        :disabled="!!filterBlocked"
        v-tooltip="{ text: t.shell.media.filterByBpmTitle, reason: filterBlocked }"
      />
      <SelectMenu
        v-model="sortKey"
        :options="sortOptions"
        class="sort-key"
        :aria-label="t.shell.media.sortAssets"
        :reason="filterBlocked"
        size="sm"
      />
      <ToggleButton
        v-if="timeStretchFn"
        v-model="syncToTempo"
        class="sync-toggle"
        :label="t.shell.media.syncTempo"
        :title="t.shell.media.syncTempoTitle"
        size="sm"
      />
      <button
        type="button"
        class="import-button"
        :disabled="!!importBlocked"
        v-tooltip="{ text: t.shell.media.importFilesTitle, reason: importBlocked }"
        @click="onImportClick"
      >
        {{ t.shell.media.importFiles }}
      </button>
      <input
        ref="fileInput"
        class="file-input"
        type="file"
        multiple
        accept="audio/*"
        aria-hidden="true"
        tabindex="-1"
        @change="onFileInputChange"
      />
    </div>

    <div v-if="importProgress" class="import-progress">
      <BusyIndicator
        :label="
          formatMessage(t.shell.media.importing, {
            done: String(Math.min(importProgress.done + 1, importProgress.total)),
            total: String(importProgress.total),
          })
        "
      />
      <div class="import-progress-track" aria-hidden="true">
        <div
          class="import-progress-fill"
          :style="{
            transform: `scaleX(${(importProgress.done + importProgress.current) / importProgress.total})`,
          }"
        />
      </div>
    </div>
    <ul v-if="importErrors.length > 0" class="import-errors" role="alert">
      <li v-for="(entry, index) in importErrors" :key="`${entry.name}-${index}`">
        <span class="error-file">{{ entry.name }}</span>: {{ entry.message }}
      </li>
    </ul>
    <p v-if="listError" class="error">{{ listError }}</p>
    <p v-if="previewError" class="error">{{ previewError }}</p>
    <p v-if="deleteError" class="error">{{ deleteError }}</p>

    <EmptyState
      v-if="loaded && displayedAssets.length === 0 && assets.length === 0"
      :message="t.shell.media.empty"
    >
      <template #action>
        <button type="button" class="empty-import" :disabled="!!importBlocked" @click="onImportClick">
          {{ t.shell.media.importFiles }}
        </button>
      </template>
      <template #icon>
        <svg viewBox="0 0 48 48" width="48" height="48">
          <path
            d="M6 30l8-9 6 7 7-10 9 12"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
          <path
            d="M30 16h12M36 10v12"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
          />
        </svg>
      </template>
    </EmptyState>
    <EmptyState
      v-else-if="loaded && displayedAssets.length === 0"
      variant="inline"
      :message="t.shell.media.noMatches"
    />
    <ul v-else class="asset-list" :aria-busy="!loaded">
      <li v-for="n in loaded ? 0 : 3" :key="`skeleton-${n}`" class="asset-skeleton" aria-hidden="true">
        <span class="asset-skeleton-bar shimmer" />
        <span class="asset-skeleton-bar is-short shimmer" />
      </li>
      <li
        v-for="asset in displayedAssets"
        :key="asset.id"
        class="asset-row"
        draggable="true"
        @dragstart="onRowDragStart($event, asset.id)"
      >
        <svg class="drag-grip" viewBox="0 0 6 14" width="6" height="14" aria-hidden="true">
          <circle cx="1.5" cy="3" r="1" fill="currentColor" />
          <circle cx="4.5" cy="3" r="1" fill="currentColor" />
          <circle cx="1.5" cy="7" r="1" fill="currentColor" />
          <circle cx="4.5" cy="7" r="1" fill="currentColor" />
          <circle cx="1.5" cy="11" r="1" fill="currentColor" />
          <circle cx="4.5" cy="11" r="1" fill="currentColor" />
        </svg>
        <button
          type="button"
          class="preview-button"
          :class="{ playing: playingId === asset.id, loading: previewLoadingId === asset.id }"
          v-tooltip="playingId === asset.id ? t.shell.media.stopPreview : t.shell.media.preview"
          :aria-label="
            playingId === asset.id
              ? formatMessage(t.shell.media.stopAsset, { name: asset.name })
              : formatMessage(t.shell.media.previewAsset, { name: asset.name })
          "
          @click="togglePreview(asset)"
        >
          <span v-if="previewLoadingId === asset.id" class="spinner preview-spinner" aria-hidden="true" />
          <svg
            v-else-if="playingId === asset.id"
            class="animate-pop"
            viewBox="0 0 12 12"
            width="9"
            height="9"
            aria-hidden="true"
          >
            <rect x="2.5" y="2.5" width="7" height="7" fill="currentColor" />
          </svg>
          <svg v-else viewBox="0 0 12 12" width="9" height="9" aria-hidden="true">
            <path d="M3.5 2.5L9.5 6l-6 3.5z" fill="currentColor" />
          </svg>
        </button>
        <div class="asset-info">
          <span class="asset-name" v-tooltip="asset.name">{{ asset.name }}</span>
          <span class="asset-summary">{{ assetSummary(asset) }}</span>
        </div>
        <div v-if="pendingDeleteId === asset.id" class="row-actions confirm">
          <span class="confirm-label">{{ t.shell.media.deleteConfirm }}</span>
          <button type="button" class="danger" @click="confirmDelete(asset.id)">
            {{ t.common.delete }}
          </button>
          <button type="button" @click="cancelDelete">{{ t.common.cancel }}</button>
        </div>
        <div v-else class="row-actions">
          <button
            type="button"
            class="add-button"
            v-tooltip="t.shell.media.addTitle"
            @click="onAdd(asset.id)"
          >
            {{ t.shell.media.add }}
          </button>
          <button
            type="button"
            class="delete-button"
            :disabled="!!deleteBlocked(asset.id)"
            v-tooltip="{ text: t.shell.media.deleteAsset, reason: deleteBlocked(asset.id) }"
            :aria-label="formatMessage(t.shell.media.deleteAssetNamed, { name: asset.name })"
            @click="requestDelete(asset.id)"
          >
            <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
              <path
                d="M3 3l6 6M9 3l-6 6"
                fill="none"
                stroke="currentColor"
                stroke-width="1.6"
                stroke-linecap="round"
              />
            </svg>
          </button>
        </div>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.media-browser {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  height: 100%;
  min-height: 0;
  padding: var(--sp-4);
  background: var(--surface-2);
  color: var(--text-1);
  font-size: var(--fs-sm);
}

/* On-brand drop target: a soft accent tint plus an inset accent ring. */
.media-browser.drag-over {
  background: var(--accent-soft);
  box-shadow: inset 0 0 0 2px var(--accent);
  transition: background var(--dur-2) var(--ease-out), box-shadow var(--dur-2) var(--ease-out);
}

.toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--sp-2);
}

/* Inherit the canonical input face and focus ring; only tighten the metrics. */
.toolbar input[type='search'],
.toolbar input[type='text'] {
  font-size: var(--fs-xs);
  padding: var(--sp-1) var(--sp-2);
}

.filter-key {
  width: 7rem;
}

.sort-key {
  width: 7rem;
}

.filter-text {
  flex: 1;
  min-width: 7rem;
}

.filter-bpm {
  width: 6.5rem;
}

.filter-bpm.invalid {
  box-shadow: inset 0 0 0 1px var(--danger), var(--control-edge), var(--inset-well);
}

/* Inherits the shared control face from controls.css; only the metrics differ. */
.import-button {
  border-radius: var(--radius-sm);
  color: var(--text-1);
  font-size: var(--fs-xs);
  padding: 0.2rem 0.6rem;
}

.import-button:disabled {
  opacity: 0.5;
  cursor: default;
}

.file-input {
  display: none;
}

.import-progress {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}

.import-progress-track {
  height: 3px;
  overflow: hidden;
  border-radius: var(--radius-full);
  background: var(--surface-inset);
  box-shadow: var(--inset-well);
}

/* Scaled rather than resized so each file tick glides without layout. */
.import-progress-fill {
  height: 100%;
  background: var(--accent);
  transform-origin: left center;
  transition: transform var(--dur-3) var(--ease-out);
}

.import-errors {
  margin: 0;
  padding: 0.3rem 0.5rem;
  list-style: none;
  background: var(--danger-surface);
  /* Inset danger ring matches the system edge form used on .danger buttons. */
  box-shadow: inset 0 0 0 1px var(--danger);
  border-radius: var(--radius-sm);
  color: var(--danger-text);
  font-size: var(--fs-xs);
}

.error-file {
  font-weight: var(--fw-semibold);
}

.error {
  margin: 0;
  color: var(--danger);
  font-size: var(--fs-xs);
}

/* Inviting onboarding frame shown when no assets have been imported yet. */
.asset-list {
  flex: 1;
  margin: 0;
  padding: 0;
  list-style: none;
  overflow-y: auto;
  border-radius: var(--radius-sm);
  min-height: 0;
  background: var(--surface-inset);
  /* Recessed well with a crisp rim — no drawn border (system retires 1px borders). */
  box-shadow: var(--control-edge), var(--inset-well);
}

.asset-row {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  padding: var(--sp-2) var(--sp-4);
  border-bottom: 1px solid var(--border-subtle);
  cursor: grab;
  transition: background var(--dur-1) var(--ease-out), box-shadow var(--dur-1) var(--ease-out);
  /* Each row fades and rises in as it mounts — imported or filtered-in assets
   * appear rather than blink. One-shot (no TransitionGroup), so removal stays
   * immediate; the shared keyframe lives in motion.css. */
  animation: view-enter var(--dur-2) var(--ease-out);
}

.asset-row:last-child {
  border-bottom: none;
}

.asset-row:hover {
  background: var(--surface-3);
  box-shadow: var(--raise-hi);
}

/* Picking the row up for an arrangement drag reads as a lift. */
.asset-row:active {
  cursor: grabbing;
  box-shadow: var(--shadow-2);
}

/* Grip dots: a discoverable drag affordance, brightening on row hover. */
.drag-grip {
  flex: none;
  color: var(--text-4);
  transition: color var(--dur-1) var(--ease-out);
}

.asset-row:hover .drag-grip {
  color: var(--text-3);
}

/* Inherits the shared control face from controls.css; only the metrics differ. */
.preview-button {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 1.5rem;
  height: 1.4rem;
  border-radius: var(--radius-sm);
  color: var(--text-1);
}

.preview-button.playing {
  --live-color: var(--accent);
  background: var(--surface-selected);
  color: var(--accent);
  animation: live-glow 1.8s var(--ease-out) infinite;
}

.preview-spinner {
  --spinner-size: 9px;
}

@media (prefers-reduced-motion: reduce) {
  .preview-button.playing {
    animation: none;
  }
}

/* Placeholder rows while the asset list is read; held back briefly so a fast
   read never flashes them. */
.asset-skeleton {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  padding: var(--sp-3) var(--sp-4);
  border-bottom: 1px solid var(--border-subtle);
  opacity: 0;
  animation: asset-skeleton-in var(--dur-2) var(--ease-out) 300ms forwards;
}

.asset-skeleton-bar {
  display: block;
  height: 8px;
  width: 60%;
  border-radius: var(--radius-xs);
  background-color: var(--surface-3);
}

.asset-skeleton-bar.is-short {
  width: 35%;
}

@keyframes asset-skeleton-in {
  to {
    opacity: 1;
  }
}

.asset-info {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 0.05rem;
  min-width: 0;
}

.asset-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: var(--fw-semibold);
}

.asset-summary {
  color: var(--text-3);
  font-size: var(--fs-xs);
  white-space: nowrap;
  /* Align the numeric fields (duration, BPM, LUFS) column-to-column across rows. */
  font-variant-numeric: tabular-nums;
}

.row-actions {
  display: flex;
  flex: none;
  align-items: center;
  gap: var(--sp-2);
}

/* Inherits the shared control face and hover/active from controls.css; compact metrics only. */
.row-actions button {
  border-radius: var(--radius-sm);
  color: var(--text-1);
  font-size: var(--fs-xs);
  padding: var(--sp-1) var(--sp-3);
}

.row-actions button:disabled {
  opacity: 0.4;
  cursor: default;
}

.delete-button {
  display: flex;
  align-items: center;
  justify-content: center;
}

.row-actions .danger {
  background: var(--danger-surface);
  color: var(--danger-text);
  box-shadow: none;
}

.confirm-label {
  color: var(--danger-text);
  font-size: var(--fs-xs);
  /* Slightly heavier than passive metadata so the destructive prompt stands out. */
  font-weight: var(--fw-medium);
}
</style>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue';
import { ensureWasm } from '@/lib/wasm';
import { type AudioAssetMeta, deleteAsset, listAssets, loadAsset } from '@/persistence/assets';
import { decodeAndIngest } from '@/project/audio-import';
import { useProjectStore } from '@/project/store';
import { setAssetDragData } from '@/ui/media/asset-drag';
import {
  type AssetSortKey,
  assetDurationSeconds,
  collectKeyTags,
  filterAssets,
  formatBpm,
  formatChannels,
  formatDuration,
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

const props = defineProps<{
  /**
   * Factory for the preview AudioContext (created lazily on first play).
   * Defaults to `() => new AudioContext()`; injectable for tests.
   */
  previewContextFactory?: PreviewContextFactory;
}>();

const emit = defineEmits<{
  /** The user asked to add this asset to the project. */
  'add-to-project': [assetId: string];
}>();

const store = useProjectStore();

/** Renders an unknown error as a display message. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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

/** Asset ids referenced by project clips; deleting these is blocked. */
const referencedIds = computed(() => referencedAssetIds(store.clips));

// --- Import ----------------------------------------------------------------

const fileInput = ref<HTMLInputElement | null>(null);
const importProgress = ref<{ done: number; total: number } | null>(null);
const importErrors = ref<Array<{ name: string; message: string }>>([]);
const dragOver = ref(false);

/** Imports the picked/dropped files one by one, collecting per-file errors. */
async function importFiles(files: ReadonlyArray<File>): Promise<void> {
  if (files.length === 0 || importProgress.value) return;
  importErrors.value = [];
  importProgress.value = { done: 0, total: files.length };
  for (const file of files) {
    try {
      await decodeAndIngest(file);
    } catch (error) {
      importErrors.value = [
        ...importErrors.value,
        { name: file.name, message: errorMessage(error) },
      ];
    }
    importProgress.value = { done: importProgress.value.done + 1, total: files.length };
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
const syncToTempo = ref(false);
const timeStretchFn = shallowRef<TimeStretchFunction | null>(null);

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
    preview.stop();
    return;
  }
  previewError.value = null;
  try {
    const loadedAsset = await loadAsset(asset.id);
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
    previewError.value = errorMessage(error);
  }
}

// --- Deletion --------------------------------------------------------------

const pendingDeleteId = ref<string | null>(null);
const deleteError = ref<string | null>(null);

function requestDelete(assetId: string): void {
  if (referencedIds.value.has(assetId)) return;
  deleteError.value = null;
  pendingDeleteId.value = assetId;
}

function cancelDelete(): void {
  pendingDeleteId.value = null;
}

async function confirmDelete(assetId: string): Promise<void> {
  pendingDeleteId.value = null;
  // Re-check: a clip may have started referencing the asset meanwhile.
  if (referencedIds.value.has(assetId)) return;
  if (playingId.value === assetId) preview.stop();
  try {
    await deleteAsset(assetId);
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

/** One-line metadata summary shown under the asset name. */
function assetSummary(asset: AudioAssetMeta): string {
  const parts = [
    formatDuration(assetDurationSeconds(asset)),
    formatChannels(asset.numChannels),
    formatSampleRate(asset.sampleRate),
  ];
  if (asset.tags?.bpm !== undefined) parts.push(`${formatBpm(asset.tags.bpm)} BPM`);
  if (asset.tags?.key) parts.push(asset.tags.key);
  return parts.join(' · ');
}

onMounted(() => {
  void refresh();
  // Probe the optional one-shot time stretcher; tempo-synced preview is
  // silently unavailable when the module does not expose it.
  void ensureWasm()
    .then((mod) => {
      const fn = (mod as { timeStretch?: unknown }).timeStretch;
      if (typeof fn === 'function') timeStretchFn.value = fn as TimeStretchFunction;
    })
    .catch(() => {
      // No wasm module: previews still work, just without tempo sync.
    });
});

onBeforeUnmount(() => {
  preview.dispose();
});
</script>

<template>
  <section
    class="media-browser"
    :class="{ 'drag-over': dragOver }"
    aria-label="Media browser"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
  >
    <div class="toolbar">
      <input
        v-model="filterText"
        class="filter-text"
        type="search"
        placeholder="Filter by name"
        aria-label="Filter assets by name"
      />
      <select v-model="filterKey" class="filter-key" aria-label="Filter by key">
        <option value="">Any key</option>
        <option v-for="key in keyOptions" :key="key" :value="key">{{ key }}</option>
      </select>
      <input
        v-model="bpmText"
        class="filter-bpm"
        :class="{ invalid: bpmInvalid }"
        type="text"
        placeholder="BPM (80-120)"
        aria-label="Filter by BPM range"
      />
      <select v-model="sortKey" class="sort-key" aria-label="Sort assets">
        <option value="name">Name</option>
        <option value="duration">Duration</option>
        <option value="bpm">BPM</option>
      </select>
      <label v-if="timeStretchFn" class="sync-toggle">
        <input v-model="syncToTempo" type="checkbox" />
        Sync to project tempo
      </label>
      <button
        type="button"
        class="import-button"
        :disabled="importProgress !== null"
        @click="onImportClick"
      >
        Import files…
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

    <p v-if="importProgress" class="import-progress" role="status">
      Importing {{ Math.min(importProgress.done + 1, importProgress.total) }} /
      {{ importProgress.total }}…
    </p>
    <ul v-if="importErrors.length > 0" class="import-errors" role="alert">
      <li v-for="(entry, index) in importErrors" :key="`${entry.name}-${index}`">
        <span class="error-file">{{ entry.name }}</span>: {{ entry.message }}
      </li>
    </ul>
    <p v-if="listError" class="error">{{ listError }}</p>
    <p v-if="previewError" class="error">{{ previewError }}</p>
    <p v-if="deleteError" class="error">{{ deleteError }}</p>

    <p v-if="loaded && displayedAssets.length === 0" class="empty">
      {{ assets.length === 0 ? 'No audio assets. Import files or drop them here.' : 'No assets match the filters.' }}
    </p>
    <ul v-else class="asset-list">
      <li
        v-for="asset in displayedAssets"
        :key="asset.id"
        class="asset-row"
        draggable="true"
        @dragstart="onRowDragStart($event, asset.id)"
      >
        <button
          type="button"
          class="preview-button"
          :class="{ playing: playingId === asset.id }"
          :title="playingId === asset.id ? 'Stop preview' : 'Preview'"
          :aria-label="playingId === asset.id ? `Stop ${asset.name}` : `Preview ${asset.name}`"
          @click="togglePreview(asset)"
        >
          {{ playingId === asset.id ? '■' : '▶' }}
        </button>
        <div class="asset-info">
          <span class="asset-name" :title="asset.name">{{ asset.name }}</span>
          <span class="asset-summary">{{ assetSummary(asset) }}</span>
        </div>
        <div v-if="pendingDeleteId === asset.id" class="row-actions confirm">
          <span class="confirm-label">Delete?</span>
          <button type="button" class="danger" @click="confirmDelete(asset.id)">Delete</button>
          <button type="button" @click="cancelDelete">Cancel</button>
        </div>
        <div v-else class="row-actions">
          <button type="button" class="add-button" @click="onAdd(asset.id)">Add</button>
          <button
            type="button"
            class="delete-button"
            :disabled="referencedIds.has(asset.id)"
            :title="
              referencedIds.has(asset.id)
                ? 'In use by project clips — remove those clips first'
                : 'Delete asset'
            "
            :aria-label="`Delete ${asset.name}`"
            @click="requestDelete(asset.id)"
          >
            ×
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
  gap: 0.4rem;
  height: 100%;
  min-height: 0;
  padding: 0.5rem;
  background: #14161b;
  color: #e2e6ee;
  font-size: 12px;
}

.media-browser.drag-over {
  outline: 1px dashed #60a5fa;
  outline-offset: -3px;
}

.toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.35rem;
}

.toolbar input[type='search'],
.toolbar input[type='text'],
.toolbar select {
  background: #1b1e25;
  border: 1px solid #2a2e38;
  border-radius: 4px;
  color: #e2e6ee;
  font-size: 11px;
  padding: 0.2rem 0.35rem;
}

.filter-text {
  flex: 1;
  min-width: 7rem;
}

.filter-bpm {
  width: 6.5rem;
}

.filter-bpm.invalid {
  border-color: #f87171;
}

.sync-toggle {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  color: #8b93a3;
  font-size: 11px;
  white-space: nowrap;
}

.import-button {
  background: #1d2940;
  border: 1px solid #2a3a5c;
  border-radius: 4px;
  color: #e2e6ee;
  cursor: pointer;
  font-size: 11px;
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
  margin: 0;
  color: #8b93a3;
}

.import-errors {
  margin: 0;
  padding: 0.3rem 0.5rem;
  list-style: none;
  background: #3a1414;
  border: 1px solid #f87171;
  border-radius: 4px;
  color: #fca5a5;
  font-size: 11px;
}

.error-file {
  font-weight: 600;
}

.error {
  margin: 0;
  color: #f87171;
  font-size: 11px;
}

.empty {
  margin: 0.4rem 0 0;
  color: #8b93a3;
}

.asset-list {
  flex: 1;
  margin: 0;
  padding: 0;
  list-style: none;
  overflow-y: auto;
  border: 1px solid #2a2e38;
  border-radius: 4px;
  min-height: 0;
}

.asset-row {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  padding: 0.25rem 0.5rem;
  border-bottom: 1px solid #1b1e25;
  cursor: grab;
}

.asset-row:last-child {
  border-bottom: none;
}

.asset-row:hover {
  background: #181b22;
}

.preview-button {
  flex: none;
  width: 1.5rem;
  height: 1.4rem;
  background: #1b1e25;
  border: 1px solid #2a2e38;
  border-radius: 4px;
  color: #e2e6ee;
  cursor: pointer;
  font-size: 10px;
  line-height: 1;
}

.preview-button.playing {
  background: #1d2940;
  border-color: #60a5fa;
  color: #60a5fa;
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
  font-weight: 600;
}

.asset-summary {
  color: #8b93a3;
  font-size: 11px;
  white-space: nowrap;
}

.row-actions {
  display: flex;
  flex: none;
  align-items: center;
  gap: 0.25rem;
}

.row-actions button {
  background: #1b1e25;
  border: 1px solid #2a2e38;
  border-radius: 4px;
  color: #e2e6ee;
  cursor: pointer;
  font-size: 11px;
  padding: 0.15rem 0.45rem;
}

.row-actions button:disabled {
  opacity: 0.4;
  cursor: default;
}

.row-actions .danger {
  background: #3a1414;
  border-color: #f87171;
  color: #fca5a5;
}

.confirm-label {
  color: #fca5a5;
  font-size: 11px;
}
</style>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue';
import SelectMenu from '@/components/shell/SelectMenu.vue';
import { ensureWasm } from '@/lib/wasm';
import { type AudioAssetMeta, deleteAsset, listAssets, loadAsset } from '@/persistence/assets';
import { decodeAndIngest } from '@/project/audio-import';
import { useProjectStore } from '@/project/store';
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
const { t } = useI18n();

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
  if (asset.tags?.lufs !== undefined) parts.push(formatLufs(asset.tags.lufs));
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
    :aria-label="t.shell.media.label"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
  >
    <div class="toolbar">
      <input
        v-model="filterText"
        class="filter-text"
        type="search"
        :placeholder="t.shell.media.filterByName"
        :aria-label="t.shell.media.filterAssetsByName"
      />
      <SelectMenu
        v-model="filterKey"
        :options="keyFilterOptions"
        class="filter-key"
        :aria-label="t.shell.media.filterByKey"
        size="sm"
      />
      <input
        v-model="bpmText"
        class="filter-bpm"
        :class="{ invalid: bpmInvalid }"
        type="text"
        :placeholder="t.shell.media.bpmPlaceholder"
        :aria-label="t.shell.media.filterByBpm"
      />
      <SelectMenu
        v-model="sortKey"
        :options="sortOptions"
        class="sort-key"
        :aria-label="t.shell.media.sortAssets"
        size="sm"
      />
      <label v-if="timeStretchFn" class="sync-toggle">
        <input v-model="syncToTempo" type="checkbox" />
        {{ t.shell.media.syncTempo }}
      </label>
      <button
        type="button"
        class="import-button"
        :disabled="importProgress !== null"
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

    <p v-if="importProgress" class="import-progress" role="status">
      {{
        formatMessage(t.shell.media.importing, {
          done: String(Math.min(importProgress.done + 1, importProgress.total)),
          total: String(importProgress.total),
        })
      }}
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
      {{ assets.length === 0 ? t.shell.media.empty : t.shell.media.noMatches }}
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
          :title="playingId === asset.id ? t.shell.media.stopPreview : t.shell.media.preview"
          :aria-label="
            playingId === asset.id
              ? formatMessage(t.shell.media.stopAsset, { name: asset.name })
              : formatMessage(t.shell.media.previewAsset, { name: asset.name })
          "
          @click="togglePreview(asset)"
        >
          {{ playingId === asset.id ? '■' : '▶' }}
        </button>
        <div class="asset-info">
          <span class="asset-name" :title="asset.name">{{ asset.name }}</span>
          <span class="asset-summary">{{ assetSummary(asset) }}</span>
        </div>
        <div v-if="pendingDeleteId === asset.id" class="row-actions confirm">
          <span class="confirm-label">{{ t.shell.media.deleteConfirm }}</span>
          <button type="button" class="danger" @click="confirmDelete(asset.id)">
            {{ t.shell.media.delete }}
          </button>
          <button type="button" @click="cancelDelete">{{ t.shell.media.cancel }}</button>
        </div>
        <div v-else class="row-actions">
          <button type="button" class="add-button" @click="onAdd(asset.id)">
            {{ t.shell.media.add }}
          </button>
          <button
            type="button"
            class="delete-button"
            :disabled="referencedIds.has(asset.id)"
            :title="
              referencedIds.has(asset.id)
                ? t.shell.media.deleteBlocked
                : t.shell.media.deleteAsset
            "
            :aria-label="formatMessage(t.shell.media.deleteAssetNamed, { name: asset.name })"
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
  background: var(--surface-2);
  color: var(--text-1);
  font-size: var(--fs-sm);
}

.media-browser.drag-over {
  outline: 1px dashed var(--accent);
  outline-offset: -3px;
}

.toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.35rem;
}

.toolbar input[type='search'],
.toolbar input[type='text'] {
  background: var(--surface-inset);
  border: none;
  border-radius: var(--radius-sm);
  color: var(--text-1);
  font-size: var(--fs-xs);
  padding: 0.2rem 0.35rem;
  box-shadow: var(--control-edge), var(--inset-well);
}

.toolbar input[type='search']:focus-visible,
.toolbar input[type='text']:focus-visible {
  outline: none;
  box-shadow: inset 0 0 0 1px var(--accent), var(--inset-well), var(--ring);
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
  box-shadow: inset 0 0 0 1px var(--danger), var(--inset-well);
}

.sync-toggle {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  color: var(--text-3);
  font-size: var(--fs-xs);
  white-space: nowrap;
}

.import-button {
  background: var(--surface-selected);
  border-radius: var(--radius-sm);
  color: var(--text-1);
  cursor: pointer;
  font-size: var(--fs-xs);
  padding: 0.2rem 0.6rem;
  box-shadow: var(--control-lift);
  transition: filter var(--dur-1) var(--ease-out), box-shadow var(--dur-1) var(--ease-out);
}

.import-button:not(:disabled):hover {
  filter: brightness(1.15);
  box-shadow: var(--control-lift-hover);
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
  color: var(--text-3);
}

.import-errors {
  margin: 0;
  padding: 0.3rem 0.5rem;
  list-style: none;
  background: var(--danger-surface);
  border: 1px solid var(--danger);
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

.empty {
  margin: 0.4rem 0 0;
  color: var(--text-3);
}

.asset-list {
  flex: 1;
  margin: 0;
  padding: 0;
  list-style: none;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  min-height: 0;
  background: var(--surface-inset);
  box-shadow: var(--inset-well);
}

.asset-row {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  padding: 0.25rem 0.5rem;
  border-bottom: 1px solid var(--border-subtle);
  cursor: grab;
  transition: background var(--dur-1) var(--ease-out);
}

.asset-row:last-child {
  border-bottom: none;
}

.asset-row:hover {
  background: var(--surface-3);
  box-shadow: var(--raise-hi);
}

.preview-button {
  flex: none;
  width: 1.5rem;
  height: 1.4rem;
  background: var(--surface-3);
  border-radius: var(--radius-sm);
  color: var(--text-1);
  cursor: pointer;
  font-size: 10px;
  line-height: 1;
  box-shadow: var(--control-lift);
}

.preview-button.playing {
  background: var(--surface-selected);
  color: var(--accent);
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
}

.row-actions {
  display: flex;
  flex: none;
  align-items: center;
  gap: 0.25rem;
}

.row-actions button {
  background: var(--surface-3);
  border-radius: var(--radius-sm);
  color: var(--text-1);
  cursor: pointer;
  font-size: var(--fs-xs);
  padding: 0.15rem 0.45rem;
  box-shadow: var(--control-lift);
  transition: filter var(--dur-1) var(--ease-out), box-shadow var(--dur-1) var(--ease-out);
}

.row-actions button:not(:disabled):hover {
  filter: brightness(1.2);
  box-shadow: var(--control-lift-hover);
}

.row-actions button:disabled {
  opacity: 0.4;
  cursor: default;
}

.row-actions .danger {
  background: var(--danger-surface);
  color: var(--danger-text);
  box-shadow: inset 0 0 0 1px var(--danger), var(--shadow-1);
}

.confirm-label {
  color: var(--danger-text);
  font-size: var(--fs-xs);
}
</style>

<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue';
import AppModal from '@/components/shell/AppModal.vue';
import BusyIndicator from '@/components/shell/BusyIndicator.vue';
import { type ExportRenderHandle, renderMixdownInWorker } from '@/export/client';
import { errorMessage } from '@/lib/errors';
import { ensureWasm } from '@/lib/wasm';
import { applyMixerSceneJson } from '@/project/commands';
import { serializeProject } from '@/project/serialization';
import { useProjectStore } from '@/project/store';
import { firstBlock } from '@/ui/disabled-reason';
import { formatMessage, useI18n } from '@/ui/i18n';
import { derivePreviewRange } from '@/ui/mastering/preview-range';
import {
  type MixAssistantStem,
  mixAssistantStripId,
  neutralMixDocument,
  suggestMixFromStems,
} from '@/ui/mixer/mix-assistant';
import type { MixAssistantResult } from '@/wasm/index.js';

/**
 * Suggests a mix from the tracks' dry material and applies it only on the
 * user's explicit Apply, as one undoable edit. The suggestion is measured over
 * the loop when one is active, else over the opening bars.
 */

const props = defineProps<{
  open: boolean;
  loopEnabled: boolean;
  loopStartPpq: number;
  loopEndPpq: number;
  /** Render seam (tests); defaults to the export worker. */
  render?: typeof renderMixdownInWorker;
}>();

const emit = defineEmits<{ close: [] }>();

/** Bars measured when no loop is active. */
const SUGGEST_BARS = 8;

const store = useProjectStore();
const { t } = useI18n();
const s = computed(() => t.value.shell.mixer.suggestMix);

const analyzing = ref(false);
const error = ref<string | null>(null);
const result = shallowRef<MixAssistantResult | null>(null);

const againBlocked = computed(() =>
  firstBlock([analyzing.value, t.value.shell.mixer.reasons.measuring]),
);
const applyBlocked = computed(() =>
  firstBlock(againBlocked.value, [!result.value, t.value.shell.mixer.reasons.noSuggestion]),
);

/** Track ids the suggestion was measured from, by the strip id it names them with. */
const measuredTracks = shallowRef<ReadonlyMap<string, { id: number; name: string }>>(new Map());
let handle: ExportRenderHandle | null = null;
let generation = 0;
let measuredProject = '';

async function analyze(): Promise<void> {
  const current = ++generation;
  handle?.cancel();
  analyzing.value = true;
  error.value = null;
  result.value = null;
  try {
    const source = serializeProject();
    measuredProject = JSON.stringify(source);
    const doc = neutralMixDocument(source);
    const range = derivePreviewRange(
      { enabled: props.loopEnabled, startPpq: props.loopStartPpq, endPpq: props.loopEndPpq },
      store.timeSignatures,
      SUGGEST_BARS,
    );
    const trackIds = store.tracks.map((track) => track.id);
    handle = (props.render ?? renderMixdownInWorker)(doc, {
      range,
      stems: true,
      includeMasterChain: false,
    });
    const rendered = await handle.result;
    if (current !== generation) return;
    if (JSON.stringify(serializeProject()) !== measuredProject) {
      error.value = s.value.stale;
      return;
    }
    const stems: MixAssistantStem[] = (rendered.stems ?? []).flatMap((stem) => {
      const track = store.tracks[stem.trackIndex];
      if ((stem.source ?? 'track') !== 'track' || !track || track.kind === 'group') return [];
      if (track.id !== trackIds[stem.trackIndex]) return [];
      return [
        { trackId: track.id, name: track.name, left: stem.channels[0], right: stem.channels[1] },
      ];
    });
    if (stems.length === 0) {
      error.value = s.value.noTracks;
      return;
    }
    const wasm = await ensureWasm();
    if (current !== generation) return;
    result.value = suggestMixFromStems(stems, rendered.sampleRate, store.tempoBpm, (request) =>
      wasm.suggestMixScene(request),
    );
    measuredTracks.value = new Map(
      stems.map((stem) => [
        mixAssistantStripId(stem.trackId),
        { id: stem.trackId, name: stem.name },
      ]),
    );
  } catch (err) {
    if (current === generation) error.value = errorMessage(err);
  } finally {
    if (current === generation) analyzing.value = false;
  }
}

watch(
  () => props.open,
  (open) => {
    if (open) void analyze();
    else {
      generation++;
      handle?.cancel();
      handle = null;
    }
  },
  { immediate: true },
);

/** Library explanation lines with strip ids read back as track names. */
const reasons = computed(() =>
  (result.value?.explanation ?? []).map((line) =>
    line.replace(/track-\d+/g, (id) => measuredTracks.value.get(id)?.name ?? id),
  ),
);

function classLabel(source: string): string {
  const classes = s.value.classes as Record<string, string>;
  return classes[source] ?? source;
}

function onApply(): void {
  const suggestion = result.value;
  if (!suggestion) return;
  if (JSON.stringify(serializeProject()) !== measuredProject) {
    error.value = s.value.stale;
    result.value = null;
    return;
  }
  const stillThere = [...measuredTracks.value.values()].every((measured) =>
    store.tracks.some((track) => track.id === measured.id),
  );
  if (!stillThere) {
    error.value = s.value.stale;
    return;
  }
  try {
    applyMixerSceneJson(JSON.stringify(suggestion.scene), { preserveTrackInserts: true });
    emit('close');
  } catch (err) {
    error.value = errorMessage(err);
  }
}
</script>

<template>
  <AppModal :open="props.open" size="lg" :aria-label="s.title" @close="emit('close')">
    <template #title>{{ s.title }}</template>

    <div class="suggest-mix">
      <p class="suggest-mix-description">{{ s.description }}</p>
      <BusyIndicator v-if="analyzing" class="suggest-mix-status" :label="s.analyzing" />

      <template v-if="result">
        <table class="suggest-mix-tracks view-enter">
          <thead>
            <tr>
              <th scope="col">{{ s.track }}</th>
              <th scope="col">{{ s.detected }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="profile in result.tracks" :key="profile.stripId">
              <td>{{ measuredTracks.get(profile.stripId)?.name ?? profile.name }}</td>
              <td>
                {{ classLabel(profile.source) }}
                <span v-if="!profile.usable" class="suggest-mix-excluded">
                  {{ formatMessage(s.excluded, { reason: profile.exclusionReason }) }}
                </span>
              </td>
            </tr>
          </tbody>
        </table>
        <section class="suggest-mix-reasons view-enter">
          <h3>{{ s.reasons }}</h3>
          <ul>
            <li v-for="(line, index) in reasons" :key="index">{{ line }}</li>
          </ul>
        </section>
      </template>

      <p v-if="error" class="dialog-error" role="alert">{{ error }}</p>
    </div>

    <template #actions>
      <button type="button" @click="emit('close')">{{ t.common.cancel }}</button>
      <button
        type="button"
        :disabled="!!againBlocked"
        v-tooltip="{ reason: againBlocked }"
        @click="analyze"
      >
        {{ s.again }}
      </button>
      <button
        type="button"
        class="primary"
        :disabled="!!applyBlocked"
        v-tooltip="{ reason: applyBlocked }"
        @click="onApply"
      >
        {{ s.apply }}
      </button>
    </template>
  </AppModal>
</template>

<style scoped>
.suggest-mix {
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
  min-height: min(420px, 60vh);
}

.suggest-mix-description {
  margin: 0;
  font-size: var(--fs-sm);
  color: var(--text-3);
}

.suggest-mix-status {
  align-self: flex-start;
}

.suggest-mix-tracks {
  border-collapse: collapse;
  font-size: var(--fs-sm);
}

.suggest-mix-tracks th {
  text-align: left;
  font-weight: var(--fw-semibold);
  color: var(--text-3);
  padding: 2px 12px 4px 0;
}

.suggest-mix-tracks td {
  padding: 3px 12px 3px 0;
  color: var(--text-2);
}

.suggest-mix-excluded {
  margin-left: var(--sp-2);
  color: var(--text-4);
}

.suggest-mix-reasons h3 {
  margin: 0 0 var(--sp-2);
  font-size: var(--fs-sm);
  font-weight: var(--fw-semibold);
  color: var(--text-3);
}

.suggest-mix-reasons ul {
  margin: 0;
  padding-left: 1.1rem;
  max-height: 14rem;
  overflow-y: auto;
  font-size: var(--fs-xs);
  line-height: 1.5;
  color: var(--text-2);
}
</style>

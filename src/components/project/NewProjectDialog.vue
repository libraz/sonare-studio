<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import type { ProjectDocument } from '@/project/serialization';
import { createTemplate, TEMPLATE_NAMES, type TemplateName } from '@/project/templates';
import { wrapTabFocus } from '@/ui/settings/focus-trap';

/**
 * Modal template picker for creating a new project. Lists the built-in
 * templates with a track preview; "Create" emits a fresh document for the
 * shell to load (the dialog never touches the store itself). When
 * `unsavedChanges` is set, a warning block (overridable via the `warning`
 * slot) reminds the user that the current project will be discarded.
 */

const props = withDefaults(
  defineProps<{
    /** Whether the dialog is visible. */
    open: boolean;
    /** Show the unsaved-changes warning above the actions. */
    unsavedChanges?: boolean;
  }>(),
  { unsavedChanges: false },
);

const emit = defineEmits<{
  /** A template was chosen; the shell should load the document. */
  create: [payload: { document: ProjectDocument; template: TemplateName }];
  /** The dialog was dismissed without creating a project. */
  cancel: [];
}>();

/** Display metadata per template. */
const TEMPLATE_INFO: Record<TemplateName, { label: string; description: string }> = {
  empty: { label: 'Empty', description: 'No tracks — start from scratch' },
  band: { label: 'Band', description: 'Drums, bass, piano, guitar and vocal' },
  'gm-orchestra': { label: 'GM Orchestra', description: 'Full orchestral section layout' },
  programming: { label: 'Programming', description: 'Synth lead, pad, pluck, bass and drums' },
  transcription: { label: 'Transcription', description: 'A single piano track' },
};

const selected = ref<TemplateName>('empty');
const dialogRef = ref<HTMLElement | null>(null);

/** Fresh document of the selected template, used for the track preview. */
const preview = computed<ProjectDocument>(() => createTemplate(selected.value));

/** Element focused before the dialog opened, restored on close. */
let previousFocus: HTMLElement | null = null;

watch(
  () => props.open,
  (open, wasOpen) => {
    if (open && !wasOpen) {
      const active = document.activeElement;
      previousFocus = active instanceof HTMLElement ? active : null;
      void nextTick(() => dialogRef.value?.focus());
    } else if (!open && wasOpen) {
      if (previousFocus?.isConnected) previousFocus.focus();
      previousFocus = null;
    }
  },
);

function onCreate(): void {
  // Emit a fresh document (not the preview) so the shell owns a private copy.
  emit('create', { document: createTemplate(selected.value), template: selected.value });
}

function onCancel(): void {
  emit('cancel');
}

/** Moves the template selection by `delta` within the list bounds. */
function moveSelection(delta: number): void {
  const index = TEMPLATE_NAMES.indexOf(selected.value);
  const next = Math.min(TEMPLATE_NAMES.length - 1, Math.max(0, index + delta));
  selected.value = TEMPLATE_NAMES[next];
}

function onKeydown(event: KeyboardEvent): void {
  if (dialogRef.value !== null && wrapTabFocus(event, dialogRef.value)) return;
  switch (event.key) {
    case 'Escape':
      event.preventDefault();
      onCancel();
      break;
    case 'Enter':
      event.preventDefault();
      onCreate();
      break;
    case 'ArrowDown':
      event.preventDefault();
      moveSelection(1);
      break;
    case 'ArrowUp':
      event.preventDefault();
      moveSelection(-1);
      break;
    default:
      break;
  }
}
</script>

<template>
  <div v-if="props.open" class="dialog-overlay" @click.self="onCancel">
    <div
      ref="dialogRef"
      class="dialog"
      role="dialog"
      aria-modal="true"
      aria-label="New project"
      tabindex="-1"
      @keydown="onKeydown"
    >
      <h2 class="dialog-title">New project</h2>
      <div class="dialog-columns">
        <ul class="template-list" role="listbox" aria-label="Project templates">
          <li
            v-for="name in TEMPLATE_NAMES"
            :key="name"
            class="template-item"
            :class="{ selected: selected === name }"
            role="option"
            :aria-selected="selected === name"
            @click="selected = name"
            @dblclick="onCreate"
          >
            <span class="template-label">{{ TEMPLATE_INFO[name].label }}</span>
            <span class="template-description">{{ TEMPLATE_INFO[name].description }}</span>
          </li>
        </ul>
        <div class="template-preview" aria-label="Template tracks">
          <h3 class="preview-title">Tracks</h3>
          <p v-if="preview.tracks.length === 0" class="preview-empty">No tracks</p>
          <ul v-else class="preview-tracks">
            <li v-for="track in preview.tracks" :key="track.name" class="preview-track">
              <span class="track-color" :style="{ background: track.color }" />
              {{ track.name }}
            </li>
          </ul>
        </div>
      </div>
      <div v-if="props.unsavedChanges" class="dialog-warning" role="alert">
        <slot name="warning">
          The current project has unsaved changes. Creating a new project will discard them.
        </slot>
      </div>
      <div class="dialog-actions">
        <button type="button" @click="onCancel">Cancel</button>
        <button type="button" class="primary" @click="onCreate">Create</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.dialog-overlay {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.55);
}

.dialog {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  width: min(34rem, calc(100vw - 2rem));
  max-height: calc(100vh - 4rem);
  padding: 1rem 1.25rem;
  background: #1b1e25;
  border: 1px solid #000;
  border-radius: 8px;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.6);
  color: #e2e6ee;
  font-size: 12px;
}

.dialog:focus {
  outline: none;
}

.dialog-title {
  margin: 0;
  font-size: 14px;
  font-weight: 700;
  letter-spacing: 0.04em;
}

.dialog-columns {
  display: flex;
  gap: 0.75rem;
  min-height: 0;
}

.template-list {
  flex: 1;
  margin: 0;
  padding: 0;
  list-style: none;
  border: 1px solid #2a2e38;
  border-radius: 4px;
  overflow: auto;
}

.template-item {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
  padding: 0.4rem 0.6rem;
  cursor: pointer;
  border-bottom: 1px solid #14161b;
}

.template-item:last-child {
  border-bottom: none;
}

.template-item:hover {
  background: #181b22;
}

.template-item.selected {
  background: #1d2940;
  box-shadow: inset 2px 0 0 #60a5fa;
}

.template-label {
  font-weight: 600;
}

.template-description {
  color: #8b93a3;
  font-size: 11px;
}

.template-preview {
  flex: 1;
  border: 1px solid #2a2e38;
  border-radius: 4px;
  padding: 0.4rem 0.6rem;
  overflow: auto;
  max-height: 16rem;
}

.preview-title {
  margin: 0 0 0.3rem;
  font-size: 11px;
  font-weight: 600;
  color: #8b93a3;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.preview-empty {
  margin: 0;
  color: #8b93a3;
}

.preview-tracks {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
}

.preview-track {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  white-space: nowrap;
}

.track-color {
  width: 0.6rem;
  height: 0.6rem;
  border-radius: 2px;
  flex: none;
}

.dialog-warning {
  background: #3a2a0c;
  border: 1px solid #fbbf24;
  border-radius: 4px;
  color: #fde68a;
  padding: 0.4rem 0.6rem;
}

.dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
}

.dialog-actions .primary {
  background: #2453a8;
  border: 1px solid #60a5fa;
  color: #e2e6ee;
  border-radius: 4px;
  padding: 0.25rem 0.9rem;
  cursor: pointer;
}
</style>

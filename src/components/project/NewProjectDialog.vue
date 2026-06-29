<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import type { ProjectDocument } from '@/project/serialization';
import { createTemplate, TEMPLATE_NAMES, type TemplateName } from '@/project/templates';
import { useI18n } from '@/ui/i18n';
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

const { t } = useI18n();

const TEMPLATE_MESSAGE_KEYS: Record<
  TemplateName,
  keyof typeof t.value.dialogs.newProject.templateInfo
> = {
  empty: 'empty',
  band: 'band',
  'gm-orchestra': 'gmOrchestra',
  programming: 'programming',
  transcription: 'transcription',
};

/** Display metadata per template. */
const templateInfo = computed<Record<TemplateName, { label: string; description: string }>>(() => ({
  empty: t.value.dialogs.newProject.templateInfo.empty,
  band: t.value.dialogs.newProject.templateInfo.band,
  'gm-orchestra': t.value.dialogs.newProject.templateInfo.gmOrchestra,
  programming: t.value.dialogs.newProject.templateInfo.programming,
  transcription: t.value.dialogs.newProject.templateInfo.transcription,
}));

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

function templateLabel(name: TemplateName): string {
  return t.value.dialogs.newProject.templateInfo[TEMPLATE_MESSAGE_KEYS[name]].label;
}

function templateDescription(name: TemplateName): string {
  return templateInfo.value[name].description;
}
</script>

<template>
  <Transition name="dialog">
  <div v-if="props.open" class="dialog-overlay" @click.self="onCancel">
    <div
      ref="dialogRef"
      class="dialog"
      role="dialog"
      aria-modal="true"
      :aria-label="t.dialogs.newProject.title"
      tabindex="-1"
      @keydown="onKeydown"
    >
      <h2 class="dialog-title">{{ t.dialogs.newProject.title }}</h2>
      <div class="dialog-columns">
        <ul class="template-list" role="listbox" :aria-label="t.dialogs.newProject.templates">
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
            <span class="template-label">{{ templateLabel(name) }}</span>
            <span class="template-description">{{ templateDescription(name) }}</span>
          </li>
        </ul>
        <div class="template-preview" :aria-label="t.dialogs.newProject.templateTracks">
          <h3 class="preview-title">{{ t.dialogs.newProject.tracks }}</h3>
          <p v-if="preview.tracks.length === 0" class="preview-empty">
            {{ t.dialogs.newProject.noTracks }}
          </p>
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
          {{ t.dialogs.newProject.warning }}
        </slot>
      </div>
      <div class="dialog-actions">
        <button type="button" @click="onCancel">{{ t.dialogs.newProject.cancel }}</button>
        <button type="button" class="primary" @click="onCreate">
          {{ t.dialogs.newProject.create }}
        </button>
      </div>
    </div>
  </div>
  </Transition>
</template>

<style scoped>
.dialog-overlay {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--scrim);
  -webkit-backdrop-filter: var(--scrim-blur);
  backdrop-filter: var(--scrim-blur);
}

.dialog {
  display: flex;
  flex-direction: column;
  gap: var(--sp-5);
  width: min(34rem, calc(100vw - 2rem));
  max-height: calc(100vh - 4rem);
  padding: 1.25rem 1.4rem;
  background: var(--glass-3);
  -webkit-backdrop-filter: var(--glass-blur-strong);
  backdrop-filter: var(--glass-blur-strong);
  border: 1px solid var(--border);
  border-radius: var(--radius-xl);
  box-shadow: var(--glass-hairline), var(--shadow-modal);
  color: var(--text-1);
  font-size: var(--fs-sm);
}

.dialog:focus {
  outline: none;
}

.dialog-title {
  margin: 0;
  font-size: var(--fs-xl);
  font-weight: var(--fw-bold);
  letter-spacing: 0.04em;
}

.dialog-columns {
  display: flex;
  gap: var(--sp-5);
  min-height: 0;
}

.template-list {
  flex: 1;
  margin: 0;
  padding: 0;
  list-style: none;
  background: var(--surface-inset);
  box-shadow: var(--control-edge), var(--inset-well);
  border-radius: var(--radius-sm);
  overflow: auto;
}

.template-item {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
  padding: var(--sp-3) var(--sp-3);
  cursor: pointer;
  border-bottom: 1px solid var(--surface-2);
  transition: background var(--dur-1) var(--ease-out);
}

.template-item:last-child {
  border-bottom: none;
}

.template-item:hover {
  background: var(--surface-3);
}

.template-item.selected {
  background: var(--accent-muted);
  box-shadow: inset 2px 0 0 var(--accent);
}

.template-label {
  font-weight: 600;
}

.template-description {
  color: var(--text-3);
  font-size: var(--fs-xs);
}

.template-preview {
  flex: 1;
  background: var(--surface-inset);
  box-shadow: var(--control-edge), var(--inset-well);
  border-radius: var(--radius-sm);
  padding: var(--sp-3) var(--sp-3);
  overflow: auto;
  max-height: 16rem;
}

.preview-title {
  margin: 0 0 var(--sp-2);
  font-size: var(--fs-xs);
  font-weight: var(--fw-semibold);
  color: var(--text-3);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.preview-empty {
  margin: 0;
  color: var(--text-3);
}

.preview-tracks {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
}

.preview-track {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  white-space: nowrap;
}

.track-color {
  width: 0.6rem;
  height: 0.6rem;
  border-radius: 2px;
  flex: none;
}

.dialog-warning {
  background: var(--warning-surface);
  border: 1px solid var(--warning);
  border-radius: var(--radius-sm);
  color: var(--warning-text);
  padding: var(--sp-3) var(--sp-3);
}

.dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--sp-4);
}

/* Share one height across secondary and the canonical .primary action. */
.dialog-actions button {
  padding: var(--sp-2) var(--sp-5);
}
</style>

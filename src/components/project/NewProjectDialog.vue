<script setup lang="ts">
import { computed, ref } from 'vue';
import AppModal from '@/components/shell/AppModal.vue';
import EmptyState from '@/components/shell/EmptyState.vue';
import { clamp } from '@/lib/math';
import type { ProjectDocument } from '@/project/serialization';
import { createTemplate, TEMPLATE_NAMES, type TemplateName } from '@/project/templates';
import { useI18n } from '@/ui/i18n';

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
  jpop: 'jpop',
  'baroque-organ': 'baroqueOrgan',
  'gm-orchestra': 'gmOrchestra',
  programming: 'programming',
  transcription: 'transcription',
};

const selected = ref<TemplateName>('empty');

/** Stable option id used by the focused listbox's active-descendant relation. */
function templateId(name: TemplateName): string {
  return `new-project-template-${name}`;
}

const activeTemplateId = computed(() => templateId(selected.value));

/** Fresh document of the selected template, used for the track preview. */
const preview = computed<ProjectDocument>(() => createTemplate(selected.value));

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
  const next = clamp(index + delta, 0, TEMPLATE_NAMES.length - 1);
  selected.value = TEMPLATE_NAMES[next];
}

/**
 * Template-list navigation and confirm, listening on the modal so it also
 * receives keys from the list; the modal shell owns Tab and Escape.
 */
function onKeydown(event: KeyboardEvent): void {
  switch (event.key) {
    case 'Enter':
      event.preventDefault();
      event.stopPropagation();
      onCreate();
      break;
    case 'ArrowDown':
      event.preventDefault();
      event.stopPropagation();
      moveSelection(1);
      break;
    case 'ArrowUp':
      event.preventDefault();
      event.stopPropagation();
      moveSelection(-1);
      break;
    default:
      break;
  }
}

/** Localized label and description of a template. */
function templateInfo(name: TemplateName): { label: string; description: string } {
  return t.value.dialogs.newProject.templateInfo[TEMPLATE_MESSAGE_KEYS[name]];
}
</script>

<template>
  <AppModal
    :open="props.open"
    :aria-label="t.dialogs.newProject.title"
    @close="onCancel"
    @keydown="onKeydown"
  >
    <template #title>{{ t.dialogs.newProject.title }}</template>
    <div class="dialog-body">
      <div class="dialog-columns">
        <ul
          class="template-list"
          role="listbox"
          tabindex="0"
          :aria-label="t.dialogs.newProject.templates"
          :aria-activedescendant="activeTemplateId"
        >
          <li
            v-for="name in TEMPLATE_NAMES"
            :id="templateId(name)"
            :key="name"
            class="template-item"
            :class="{ selected: selected === name }"
            role="option"
            :aria-selected="selected === name"
            @click="selected = name"
            @dblclick="onCreate"
          >
            <span class="template-label">{{ templateInfo(name).label }}</span>
            <span class="template-description">{{ templateInfo(name).description }}</span>
          </li>
        </ul>
        <div class="template-preview" :aria-label="t.dialogs.newProject.templateTracks">
          <h3 class="preview-title">{{ t.dialogs.newProject.tracks }}</h3>
          <EmptyState
            v-if="preview.tracks.length === 0"
            variant="inline"
            :message="t.dialogs.newProject.noTracks"
          />
          <ul v-else :key="selected" class="preview-tracks view-enter">
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
    </div>
    <template #actions>
      <button type="button" @click="onCancel">{{ t.dialogs.newProject.cancel }}</button>
      <button type="button" class="primary" @click="onCreate">
        {{ t.dialogs.newProject.create }}
      </button>
    </template>
  </AppModal>
</template>

<style scoped>
.dialog-body {
  display: flex;
  flex-direction: column;
  gap: var(--sp-5);
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
  padding: var(--sp-3) var(--sp-4);
  cursor: pointer;
  border-bottom: 1px solid var(--border-subtle);
  transition:
    background var(--dur-1) var(--ease-out),
    color var(--dur-1) var(--ease-out);
}

.template-item:last-child {
  border-bottom: none;
}

.template-item:hover:not(.selected) {
  background: var(--surface-4);
}

/* Selection reads as a full accent-tinted row (no one-sided stripe): tinted
 * fill plus an accent label. */
.template-item.selected {
  background: var(--surface-selected);
}

.template-item.selected .template-label {
  color: var(--accent);
}

.template-label {
  font-weight: var(--fw-semibold);
  color: var(--text-1);
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
</style>

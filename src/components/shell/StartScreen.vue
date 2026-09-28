<script setup lang="ts">
import { computed } from 'vue';
import AppModal from '@/components/shell/AppModal.vue';
import BrandMark from '@/components/shell/BrandMark.vue';
import type { StoredProjectInfo } from '@/persistence/opfs';
import { formatMessage, useI18n } from '@/ui/i18n';
import { formatSize, formatTimestamp } from '@/ui/shell/format';

/**
 * First-run / on-demand launcher. Shown over a freshly loaded empty project so
 * the shell renders behind it; the user must pick what to open instead of
 * silently landing in a demo: continue the autosaved session, create a new
 * project, open the bundled demo song, or open / import a saved project.
 *
 * The layout is a compact launcher: a brand header, a short list of project
 * actions, saved projects, and secondary import/backup actions.
 *
 * The overlay sits below the modal layer (z-index 90 < 100) so the New and Open
 * dialogs it triggers render on top of it; it stays mounted until a project is
 * actually loaded.
 */

const props = defineProps<{
  /** Whether the launcher is visible. */
  open: boolean;
  /** Whether browser project storage (OPFS) is available. */
  opfsAvailable: boolean;
  /** Whether a restorable autosaved session exists. */
  hasAutosave: boolean;
  /** Saved projects to list (autosave slot excluded by the caller). */
  storedProjects: StoredProjectInfo[];
}>();

const emit = defineEmits<{
  /** Restore the autosaved session. */
  continueSession: [];
  /** Open the new-project template picker. */
  newProject: [];
  /** Open the bundled demo song. */
  demo: [];
  /** Open a saved project by name. */
  openProject: [name: string];
  /** Import a .szd project from a local file. */
  importProject: [];
  /** Restore all browser-backed projects/media from a backup archive. */
  importBackup: [];
  /** Export all browser-backed projects/media as a backup archive. */
  exportBackup: [];
  /** Import a MIDI file as a new project. */
  importMidi: [];
}>();

const { t, locale } = useI18n();

/** Upstream audio engine — surfaced in the launcher disclaimer. */
const LIBSONARE_URL = 'https://github.com/libraz/libsonare';

/**
 * The headline action gets the brand-bordered primary treatment: continuing a
 * session when one exists, otherwise creating a new project.
 */
const primaryAction = computed<'continue' | 'new'>(() => (props.hasAutosave ? 'continue' : 'new'));

/** Localized last-modified date for a stored project, or an empty string. */
function projectDate(info: StoredProjectInfo): string {
  if (info.lastModified === undefined) return '';
  return formatTimestamp(info.lastModified, locale.value, 'date');
}

/** Compact "size · date" meta line for a stored project. */
function projectMeta(info: StoredProjectInfo): string {
  const date = projectDate(info);
  const size = formatSize(info.size);
  return date === '' ? size : formatMessage(t.value.shell.startScreen.projectMeta, { size, date });
}
</script>

<template>
  <AppModal
    :open="props.open"
    :aria-label="t.shell.startScreen.label"
    size="md"
    layer="launcher"
    :dismissable="false"
    :close-on-overlay="false"
  >
    <div class="ss-content">
        <header class="ss-head">
          <BrandMark size="lg" />
          <p class="ss-subtitle">{{ t.shell.startScreen.subtitle }}</p>
        </header>

        <div class="ss-body">
          <button v-if="props.hasAutosave" type="button" class="ss-action"
            :class="{ primary: primaryAction === 'continue' }" data-testid="start-continue"
            @click="emit('continueSession')">
            <span class="ss-action-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"
                stroke-linecap="round" stroke-linejoin="round">
                <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                <path d="M3 3v5h5" />
                <path d="M12 7.5v4.7l3.6 2.1" />
              </svg>
            </span>
            <span class="ss-action-text">
              <strong>{{ t.shell.startScreen.continueTitle }}</strong>
              <span>{{ t.shell.startScreen.continueDesc }}</span>
            </span>
            <svg class="ss-action-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M9 6l6 6-6 6" />
            </svg>
          </button>

          <button type="button" class="ss-action" :class="{ primary: primaryAction === 'new' }"
            data-testid="start-new" @click="emit('newProject')">
            <span class="ss-action-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"
                stroke-linecap="round" stroke-linejoin="round">
                <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" />
                <path d="M14 3v5h5" />
                <path d="M12 12v6M9 15h6" />
              </svg>
            </span>
            <span class="ss-action-text">
              <strong>{{ t.shell.startScreen.newTitle }}</strong>
              <span>{{ t.shell.startScreen.newDesc }}</span>
            </span>
            <svg class="ss-action-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M9 6l6 6-6 6" />
            </svg>
          </button>

          <button type="button" class="ss-action" data-testid="start-demo" @click="emit('demo')">
            <span class="ss-action-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"
                stroke-linecap="round" stroke-linejoin="round">
                <path d="M9 17V5.2l10-2.1V15" />
                <circle cx="6.5" cy="17" r="2.5" />
                <circle cx="16.5" cy="15" r="2.5" />
              </svg>
            </span>
            <span class="ss-action-text">
              <strong>{{ t.shell.startScreen.demoTitle }}</strong>
              <span>{{ t.shell.startScreen.demoDesc }}</span>
            </span>
            <svg class="ss-action-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M9 6l6 6-6 6" />
            </svg>
          </button>

          <template v-if="props.storedProjects.length > 0">
            <div class="ss-divider"><span>{{ t.shell.startScreen.openHeading }}</span></div>
            <div class="ss-projects">
              <button v-for="info in props.storedProjects" :key="info.name" type="button"
                class="ss-project" @click="emit('openProject', info.name)">
                <span class="ss-project-name">{{ info.name }}</span>
                <span class="ss-project-meta">{{ projectMeta(info) }}</span>
              </button>
            </div>
          </template>

          <div class="ss-imports">
            <button v-if="props.opfsAvailable" type="button" class="ss-import"
              data-testid="start-import" @click="emit('importProject')">
              <svg class="ss-import-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M12 3v11" />
                <path d="M8 10l4 4 4-4" />
                <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
              </svg>
              <span class="ss-import-label">{{ t.shell.startScreen.importFromFile }}</span>
            </button>
            <button v-if="props.opfsAvailable" type="button" class="ss-import"
              data-testid="start-import-backup" @click="emit('importBackup')">
              <svg class="ss-import-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M4 8.5h16V19a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 19Z" />
                <path d="M3 4h18v4.5H3Z" />
                <path d="M12 17v-5M9.5 14.5 12 12l2.5 2.5" />
              </svg>
              <span class="ss-import-label">{{ t.shell.startScreen.restoreBackup }}</span>
            </button>
            <button v-if="props.opfsAvailable" type="button" class="ss-import"
              data-testid="start-export-backup" @click="emit('exportBackup')">
              <svg class="ss-import-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M4 8.5h16V19a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 19Z" />
                <path d="M3 4h18v4.5H3Z" />
                <path d="M12 12v5M9.5 14.5 12 17l2.5-2.5" />
              </svg>
              <span class="ss-import-label">{{ t.shell.startScreen.exportBackup }}</span>
            </button>
            <button type="button" class="ss-import" data-testid="start-import-midi"
              @click="emit('importMidi')">
              <svg class="ss-import-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M8 16V6.5l9-1.6V14" />
                <circle cx="5.75" cy="16" r="2.25" />
                <circle cx="14.75" cy="14" r="2.25" />
              </svg>
              <span class="ss-import-label">{{ t.shell.startScreen.importMidiFile }}</span>
            </button>
          </div>
        </div>

        <footer class="ss-notice">
          <p class="ss-notice-text">{{ t.shell.startScreen.noticeBody }}</p>
          <a class="ss-notice-link" :href="LIBSONARE_URL" target="_blank" rel="noopener noreferrer">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true">
              <path d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48l-.01-1.7c-2.78.6-3.37-1.34-3.37-1.34-.46-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.61.07-.61 1 .07 1.53 1.03 1.53 1.03.89 1.53 2.34 1.09 2.91.83.09-.65.35-1.09.63-1.34-2.22-.25-4.56-1.11-4.56-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.65 0 0 .84-.27 2.75 1.02a9.5 9.5 0 0 1 5 0c1.91-1.29 2.75-1.02 2.75-1.02.55 1.38.2 2.4.1 2.65.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.69-4.57 4.94.36.31.68.92.68 1.85l-.01 2.74c0 .27.18.58.69.48A10 10 0 0 0 12 2Z" />
            </svg>
            {{ t.shell.startScreen.noticeRepoLabel }}
          </a>
        </footer>
    </div>
  </AppModal>
</template>

<style scoped>
.ss-content {
  overflow: hidden auto;
}

.ss-head {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--sp-2);
  padding: var(--sp-8) var(--sp-8) var(--sp-6);
  text-align: left;
}

.ss-subtitle {
  margin: 0;
  font-size: var(--fs-md);
  color: var(--text-3);
}

.ss-body {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  padding: 0 var(--sp-8) var(--sp-7);
}

/* --- Action buttons --------------------------------------------------- */
.ss-action {
  display: flex;
  align-items: center;
  gap: var(--sp-5);
  width: 100%;
  padding: var(--sp-4) var(--sp-5);
  text-align: left;
  border: 1px solid transparent;
  border-radius: var(--radius-lg);
  background: var(--surface-2);
  box-shadow: none;
  color: var(--text-1);
  cursor: pointer;
  transition:
    background var(--dur-1) var(--ease-out),
    border-color var(--dur-1) var(--ease-out);
}

.ss-action:hover {
  background: var(--surface-3);
}

.ss-action:active {
  background: var(--surface-4);
}

.ss-action:focus-visible {
  outline: none;
  box-shadow: var(--ring);
}

.ss-action.primary {
  background: var(--accent-soft);
}

.ss-action.primary:hover {
  background: color-mix(in srgb, var(--accent) 14%, var(--surface-2));
}

.ss-action.primary:focus-visible {
  box-shadow: var(--ring);
}

.ss-action-icon {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 38px;
  height: 38px;
  border-radius: var(--radius-md);
  background: var(--surface-1);
  color: var(--text-2);
}

.ss-action-icon svg {
  width: 22px;
  height: 22px;
}

.ss-action.primary .ss-action-icon {
  background: color-mix(in srgb, var(--accent) 16%, var(--surface-2));
  color: var(--accent);
}

.ss-action-text {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.ss-action-text strong {
  font-size: var(--fs-lg);
  font-weight: var(--fw-semibold);
  letter-spacing: -0.01em;
  color: var(--text-1);
}

.ss-action-text span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-sm);
  line-height: 1.35;
  color: var(--text-3);
}

.ss-action-arrow {
  flex: none;
  width: 18px;
  height: 18px;
  color: var(--text-4);
  transition: color var(--dur-1) var(--ease-out);
}

.ss-action:hover .ss-action-arrow {
  color: var(--text-3);
}

.ss-action.primary .ss-action-arrow {
  color: var(--accent);
}

/* --- Divider ---------------------------------------------------------- */
.ss-divider {
  display: flex;
  align-items: center;
  gap: var(--sp-5);
  margin: var(--sp-2) 0 0;
  font-size: var(--fs-xs);
  color: var(--text-3);
}

.ss-divider::before,
.ss-divider::after {
  content: '';
  flex: 1;
  height: 1px;
  background: var(--border-subtle);
}

/* --- Saved projects --------------------------------------------------- */
.ss-projects {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  max-height: 196px;
  overflow-y: auto;
}

.ss-project {
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 100%;
  padding: var(--sp-4) var(--sp-5);
  text-align: left;
  border: 1px solid transparent;
  border-radius: var(--radius-md);
  background: var(--surface-2);
  box-shadow: none;
  cursor: pointer;
  transition:
    background var(--dur-1) var(--ease-out),
    border-color var(--dur-1) var(--ease-out);
}

.ss-project:hover {
  background: var(--surface-4);
}

.ss-project:focus-visible {
  outline: none;
  box-shadow: var(--ring);
}

.ss-project-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-md);
  font-weight: var(--fw-medium);
  color: var(--text-1);
}

.ss-project-meta {
  font-size: var(--fs-xs);
  color: var(--text-4);
}

/* --- Secondary import / backup chips ---------------------------------- */
/* Two columns so each chip has room for its label on a single line — the
 * four-across grid forced ugly mid-word wraps in Japanese. */
.ss-imports {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--sp-3);
}

.ss-import {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  width: 100%;
  padding: var(--sp-3) var(--sp-4);
  border: 1px solid transparent;
  border-radius: var(--radius-md);
  background: var(--surface-2);
  box-shadow: none;
  color: var(--text-2);
  font: inherit;
  font-size: var(--fs-sm);
  text-align: left;
  cursor: pointer;
  transition:
    color var(--dur-1) var(--ease-out),
    background var(--dur-1) var(--ease-out),
    border-color var(--dur-1) var(--ease-out);
}

.ss-import-icon {
  flex: none;
  width: 17px;
  height: 17px;
  color: var(--text-3);
  transition: color var(--dur-1) var(--ease-out);
}

.ss-import-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ss-import:hover {
  color: var(--text-1);
  background: var(--surface-4);
}

.ss-import:hover .ss-import-icon {
  color: var(--accent);
}

.ss-import:active {
  background: var(--surface-1);
}

.ss-import:focus-visible {
  outline: none;
  box-shadow: var(--ring);
}

/* --- Disclaimer footer ------------------------------------------------ */
.ss-notice {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--sp-2);
  padding: var(--sp-5) var(--sp-8) var(--sp-6);
  border-top: 1px solid var(--border-subtle);
  background: var(--surface-2);
  text-align: left;
}

.ss-notice-text {
  margin: 0;
  max-width: 56ch;
  font-size: var(--fs-xs);
  line-height: 1.5;
  color: var(--text-4);
}

.ss-notice-link {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-1) var(--sp-3);
  border-radius: var(--radius-sm);
  color: var(--text-3);
  font-size: var(--fs-xs);
  font-weight: var(--fw-medium);
  text-decoration: none;
  transition:
    color var(--dur-1) var(--ease-out),
    background var(--dur-1) var(--ease-out);
}

.ss-notice-link:hover {
  color: var(--accent);
  background: var(--accent-soft);
}

.ss-notice-link:focus-visible {
  outline: none;
  box-shadow: var(--ring);
}
</style>

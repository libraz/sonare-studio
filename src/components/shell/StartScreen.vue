<script setup lang="ts">
import { computed } from 'vue';
import BrandMark from '@/components/shell/BrandMark.vue';
import type { StoredProjectInfo } from '@/persistence/opfs';
import { formatMessage, useI18n } from '@/ui/i18n';
import { formatSize } from '@/ui/shell/format';

/**
 * First-run / on-demand launcher. Shown over a freshly loaded empty project so
 * the shell renders behind it; the user must pick what to open instead of
 * silently landing in a demo: continue the autosaved session, create a new
 * project, open the bundled demo song, or open / import a saved project.
 *
 * The layout mirrors the formetra welcome modal — a compact centred dialog with
 * a brand header, primary-bordered action buttons carrying a round icon and a
 * title/subtitle, an "open saved" divider, a list of saved projects, and a
 * dashed import button — re-skinned onto the sonare design tokens.
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
  /** Import a project from a local file. */
  importProject: [];
}>();

const { t, locale } = useI18n();

/**
 * The headline action gets the brand-bordered primary treatment: continuing a
 * session when one exists, otherwise creating a new project.
 */
const primaryAction = computed<'continue' | 'new'>(() => (props.hasAutosave ? 'continue' : 'new'));

/** Localized last-modified date for a stored project, or an empty string. */
function projectDate(info: StoredProjectInfo): string {
  if (info.lastModified === undefined) return '';
  return new Date(info.lastModified).toLocaleDateString(locale.value);
}

/** Compact "size · date" meta line for a stored project. */
function projectMeta(info: StoredProjectInfo): string {
  const date = projectDate(info);
  const size = formatSize(info.size);
  return date === '' ? size : formatMessage(t.value.shell.startScreen.projectMeta, { size, date });
}
</script>

<template>
  <Teleport to="body">
    <div v-if="props.open" class="ss-overlay" role="dialog" aria-modal="true"
      :aria-label="t.shell.startScreen.label">
      <div class="ss-modal">
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
                <path d="M3.5 12a8.5 8.5 0 1 1 2.5 6" />
                <path d="M5 18.5V14H9.5" />
                <path d="M12 8v4.2l2.8 1.7" />
              </svg>
            </span>
            <span class="ss-action-text">
              <strong>{{ t.shell.startScreen.continueTitle }}</strong>
              <span>{{ t.shell.startScreen.continueDesc }}</span>
            </span>
          </button>

          <button type="button" class="ss-action" :class="{ primary: primaryAction === 'new' }"
            data-testid="start-new" @click="emit('newProject')">
            <span class="ss-action-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"
                stroke-linecap="round" stroke-linejoin="round">
                <path d="M6 3.5h7l5 5V20.5H6Z" />
                <path d="M13 3.5V9h5" />
                <path d="M12 12.5v5M9.5 15h5" />
              </svg>
            </span>
            <span class="ss-action-text">
              <strong>{{ t.shell.startScreen.newTitle }}</strong>
              <span>{{ t.shell.startScreen.newDesc }}</span>
            </span>
          </button>

          <button type="button" class="ss-action" data-testid="start-demo" @click="emit('demo')">
            <span class="ss-action-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"
                stroke-linecap="round" stroke-linejoin="round">
                <path d="M9 17V5.5l9-2v10" />
                <circle cx="6.5" cy="17" r="2.5" />
                <circle cx="15.5" cy="13.5" r="2.5" />
              </svg>
            </span>
            <span class="ss-action-text">
              <strong>{{ t.shell.startScreen.demoTitle }}</strong>
              <span>{{ t.shell.startScreen.demoDesc }}</span>
            </span>
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

          <button v-if="props.opfsAvailable" type="button" class="ss-import" data-testid="start-import"
            @click="emit('importProject')">
            {{ t.shell.startScreen.importFromFile }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.ss-overlay {
  position: fixed;
  inset: 0;
  z-index: 90;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--sp-8);
  background: var(--scrim);
  -webkit-backdrop-filter: var(--scrim-blur);
  backdrop-filter: var(--scrim-blur);
  animation: ss-fade var(--dur-3) var(--ease-out);
}

.ss-modal {
  width: 420px;
  max-width: 100%;
  max-height: 100%;
  overflow: hidden auto;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-modal);
  animation: ss-rise var(--dur-3) var(--ease-spring);
}

.ss-head {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-8) var(--sp-7) var(--sp-6);
  text-align: center;
}

.ss-subtitle {
  margin: 0;
  font-size: var(--fs-md);
  color: var(--text-3);
}

.ss-body {
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
  padding: 0 var(--sp-7) var(--sp-7);
}

/* --- Action buttons --------------------------------------------------- */
.ss-action {
  display: flex;
  align-items: center;
  gap: var(--sp-5);
  width: 100%;
  padding: var(--sp-5) var(--sp-6);
  text-align: left;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--surface-3);
  color: var(--text-1);
  cursor: pointer;
  transition:
    background var(--dur-1) var(--ease-out),
    border-color var(--dur-1) var(--ease-out);
}

.ss-action:hover {
  background: var(--surface-4);
  border-color: var(--border-strong);
}

.ss-action:focus-visible {
  outline: none;
  box-shadow: var(--ring);
}

.ss-action.primary {
  border: 2px solid var(--accent);
  background: var(--accent-soft);
}

.ss-action.primary:hover {
  background: color-mix(in srgb, var(--accent), transparent 84%);
}

.ss-action-icon {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border-radius: var(--radius-full);
  background: var(--surface-inset);
  color: var(--text-3);
}

.ss-action-icon svg {
  width: 22px;
  height: 22px;
}

.ss-action.primary .ss-action-icon {
  background: var(--accent-soft);
  color: var(--accent);
}

.ss-action-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.ss-action-text strong {
  font-size: var(--fs-lg);
  font-weight: var(--fw-semibold);
  color: var(--text-1);
}

.ss-action-text span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-sm);
  color: var(--text-3);
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
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: transparent;
  cursor: pointer;
  transition:
    background var(--dur-1) var(--ease-out),
    border-color var(--dur-1) var(--ease-out);
}

.ss-project:hover {
  background: var(--surface-3);
  border-color: var(--border);
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

/* --- Import (dashed) -------------------------------------------------- */
.ss-import {
  width: 100%;
  padding: var(--sp-4);
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius-sm);
  background: none;
  color: var(--text-3);
  font: inherit;
  font-size: var(--fs-sm);
  cursor: pointer;
  transition:
    color var(--dur-1) var(--ease-out),
    border-color var(--dur-1) var(--ease-out);
}

.ss-import:hover {
  color: var(--text-2);
  border-color: var(--text-4);
}

.ss-import:focus-visible {
  outline: none;
  box-shadow: var(--ring);
}

@keyframes ss-fade {
  from { opacity: 0; }
  to { opacity: 1; }
}

@keyframes ss-rise {
  from { opacity: 0; transform: translateY(8px) scale(0.98); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}

@media (prefers-reduced-motion: reduce) {
  .ss-overlay,
  .ss-modal {
    animation: none;
  }
}
</style>

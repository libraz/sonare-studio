<script setup lang="ts">
import { computed } from 'vue';
import { useNoteNames } from '@/composables/useNoteNames';
import { clamp } from '@/lib/math';
import { updateNotes } from '@/project/commands';
import { useProjectStore } from '@/project/store';
import type { EditorNote, EditorNoteUpdate } from '@/project/types';
import { firstBlock } from '@/ui/disabled-reason';
import { formatMessage, useI18n } from '@/ui/i18n';

/**
 * Info Line: a horizontal strip above the piano roll showing the selected
 * note's Start / End / Length / Pitch / Velocity / Channel / Off-velocity as
 * directly type-editable fields. With multiple notes selected, the fields
 * show the anchor note (the most recently selected one) and edits apply as
 * deltas to every selected note; channel and off-velocity are set absolutely.
 * Commits go through the project commands (one undoable edit per commit).
 */

/** Smallest note length an Info Line edit can produce, in PPQ. */
const MIN_DURATION_PPQ = 0.001;

const store = useProjectStore();
const { t } = useI18n();
const { formatPitch, parsePitch } = useNoteNames();

/** The anchor note: the most recently selected id drives the displayed values. */
const anchorNote = computed<EditorNote | null>(() => {
  let lastId: number | null = null;
  for (const id of store.selection) lastId = id;
  if (lastId === null) return null;
  return store.notes.find((note) => note.id === lastId) ?? null;
});

const selectionCount = computed(() => store.selection.size);

/** One gate for the whole line: every field edits the same selection. */
const blocked = computed(() =>
  firstBlock(
    [anchorNote.value === null, t.value.reasons.noNoteSelection],
    [store.activeTrack?.frozen !== undefined, t.value.reasons.trackFrozen],
  ),
);

/** Clamps a value into [min, max]. */
/** Formats a PPQ value for display (rounded to milli-PPQ, no trailing zeros). */
function formatPpq(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

/** Parses a finite number, or null for empty / non-numeric text. */
function parseNumber(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

/** Parses an integer, or null for empty / non-integer text. */
function parseInteger(text: string): number | null {
  const value = parseNumber(text);
  return value !== null && Number.isInteger(value) ? value : null;
}

type FieldKey = 'start' | 'end' | 'length' | 'pitch' | 'velocity' | 'channel' | 'offVelocity';

interface FieldDef {
  key: FieldKey;
  label: string;
  title: string;
  display: (note: EditorNote) => string;
  parse: (text: string) => number | null;
}

const fields = computed<FieldDef[]>(() => {
  const labels = t.value.shell.pianoRoll.info.fields;
  return [
    {
      key: 'start',
      label: labels.start.label,
      title: labels.start.title,
      display: (note) => formatPpq(note.startPpq),
      parse: parseNumber,
    },
    {
      key: 'end',
      label: labels.end.label,
      title: labels.end.title,
      display: (note) => formatPpq(note.startPpq + note.durationPpq),
      parse: parseNumber,
    },
    {
      key: 'length',
      label: labels.length.label,
      title: labels.length.title,
      display: (note) => formatPpq(note.durationPpq),
      parse: parseNumber,
    },
    {
      key: 'pitch',
      label: labels.pitch.label,
      title: labels.pitch.title,
      display: (note) => formatPitch(note.pitch),
      parse: parsePitch,
    },
    {
      key: 'velocity',
      label: labels.velocity.label,
      title: labels.velocity.title,
      display: (note) => String(note.velocity),
      parse: parseInteger,
    },
    {
      key: 'channel',
      label: labels.channel.label,
      title: labels.channel.title,
      display: (note) => String(note.channel + 1),
      parse: parseInteger,
    },
    {
      key: 'offVelocity',
      label: labels.offVelocity.label,
      title: labels.offVelocity.title,
      display: (note) => (note.offVelocity !== undefined ? String(note.offVelocity) : ''),
      parse: parseInteger,
    },
  ];
});

/**
 * Builds the per-note updates for one committed field value. Numeric fields
 * apply the delta from the anchor to every selected note (equivalent to an
 * absolute set for a single note); channel and off-velocity are absolute.
 */
function buildUpdates(key: FieldKey, value: number, anchor: EditorNote): EditorNoteUpdate[] {
  const targets = store.selectedNotes;
  switch (key) {
    case 'start': {
      const delta = Math.max(0, value) - anchor.startPpq;
      return targets.map((note) => ({ id: note.id, startPpq: Math.max(0, note.startPpq + delta) }));
    }
    case 'end': {
      const delta = value - (anchor.startPpq + anchor.durationPpq);
      return targets.map((note) => ({
        id: note.id,
        durationPpq: Math.max(MIN_DURATION_PPQ, note.durationPpq + delta),
      }));
    }
    case 'length': {
      const delta = Math.max(MIN_DURATION_PPQ, value) - anchor.durationPpq;
      return targets.map((note) => ({
        id: note.id,
        durationPpq: Math.max(MIN_DURATION_PPQ, note.durationPpq + delta),
      }));
    }
    case 'pitch': {
      const delta = clamp(value, 0, 127) - anchor.pitch;
      return targets.map((note) => ({ id: note.id, pitch: clamp(note.pitch + delta, 0, 127) }));
    }
    case 'velocity': {
      const delta = clamp(value, 1, 127) - anchor.velocity;
      return targets.map((note) => ({
        id: note.id,
        velocity: clamp(note.velocity + delta, 1, 127),
      }));
    }
    case 'channel': {
      const channel = clamp(value - 1, 0, 15);
      return targets.map((note) => ({ id: note.id, channel }));
    }
    case 'offVelocity': {
      const offVelocity = clamp(value, 1, 127);
      return targets.map((note) => ({ id: note.id, offVelocity }));
    }
  }
}

/** Commits one field edit; invalid input reverts the field to the note value. */
function onCommit(field: FieldDef, event: Event): void {
  const input = event.target as HTMLInputElement;
  const anchor = anchorNote.value;
  if (!anchor || blocked.value) {
    input.value = anchor ? field.display(anchor) : '';
    return;
  }
  const parsed = field.parse(input.value);
  if (parsed === null) {
    input.value = field.display(anchor);
    return;
  }
  const updates = buildUpdates(field.key, parsed, anchor);
  if (updates.length > 0) updateNotes(updates);
  // Re-sync the field so clamped / normalized values are reflected even when
  // the rendered binding did not change.
  const refreshed = anchorNote.value;
  input.value = refreshed ? field.display(refreshed) : '';
}

/** Enter commits by blurring (the change event fires the commit). */
function onEnter(event: KeyboardEvent): void {
  (event.target as HTMLInputElement).blur();
}

/** Escape discards the edit and restores the displayed value. */
function onEscape(field: FieldDef, event: KeyboardEvent): void {
  const input = event.target as HTMLInputElement;
  const anchor = anchorNote.value;
  input.value = anchor ? field.display(anchor) : '';
  input.blur();
}
</script>

<template>
  <div class="info-line" role="group" :aria-label="t.shell.pianoRoll.info.label">
    <label
      v-for="field in fields"
      :key="field.key"
      class="info-line__field"
      v-tooltip="{ text: field.title, reason: blocked }"
    >
      <span class="info-line__label">{{ field.label }}</span>
      <input
        class="info-line__input"
        type="text"
        spellcheck="false"
        autocomplete="off"
        :value="anchorNote ? field.display(anchorNote) : ''"
        :disabled="!!blocked"
        :placeholder="anchorNote ? '' : '—'"
        :aria-label="field.title"
        @change="onCommit(field, $event)"
        @keydown.enter="onEnter"
        @keydown.esc="onEscape(field, $event)"
        @keydown.stop
      />
    </label>
    <span v-if="blocked" class="info-line__count">{{ blocked }}</span>
    <span v-else-if="selectionCount > 1" class="info-line__count">
      {{ formatMessage(t.shell.pianoRoll.info.count, { count: selectionCount }) }}
    </span>
  </div>
</template>

<style scoped>
.info-line {
  display: flex;
  align-items: center;
  gap: var(--sp-5);
  min-width: 0;
  padding: var(--sp-2) var(--sp-4);
  overflow-x: auto;
  scrollbar-width: none;
  background: var(--surface-3);
  border-bottom: 1px solid var(--border);
  font-size: var(--fs-sm);
  color: var(--text-2);
  user-select: none;
}

.info-line__field {
  display: flex;
  align-items: center;
  flex: none;
  gap: var(--sp-2);
}

.info-line__label {
  text-transform: uppercase;
  letter-spacing: 0.04em;
  font-size: var(--fs-xs);
  color: var(--text-3);
}

.info-line__input {
  width: 4rem;
  padding: var(--sp-1) var(--sp-2);
  background: var(--surface-inset);
  border: none;
  border-radius: var(--radius-sm);
  box-shadow: var(--control-edge), var(--inset-well);
  color: var(--text-1);
  font: inherit;
  font-variant-numeric: tabular-nums;
  transition: box-shadow var(--dur-1) var(--ease-out);
}

.info-line__input:focus-visible {
  outline: none;
  box-shadow: inset 0 0 0 1px var(--accent), var(--inset-well), var(--ring);
}

.info-line__input:disabled {
  opacity: 0.45;
}

.info-line__count {
  margin-left: auto;
  flex: none;
  color: var(--text-3);
  font-size: var(--fs-xs);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
</style>

<script setup lang="ts">
import { computed } from 'vue';
import { formatPitch, parsePitch } from '@/lib/pitch';
import { updateNotes } from '@/project/commands';
import { useProjectStore } from '@/project/store';
import type { EditorNote, EditorNoteUpdate } from '@/project/types';

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

/** The anchor note: the most recently selected id drives the displayed values. */
const anchorNote = computed<EditorNote | null>(() => {
  let lastId: number | null = null;
  for (const id of store.selection) lastId = id;
  if (lastId === null) return null;
  return store.notes.find((note) => note.id === lastId) ?? null;
});

const selectionCount = computed(() => store.selection.size);

/** Clamps a value into [min, max]. */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

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

const fields: FieldDef[] = [
  {
    key: 'start',
    label: 'Start',
    title: 'Note start (PPQ, quarter notes)',
    display: (note) => formatPpq(note.startPpq),
    parse: parseNumber,
  },
  {
    key: 'end',
    label: 'End',
    title: 'Note end (PPQ, quarter notes); edits the length',
    display: (note) => formatPpq(note.startPpq + note.durationPpq),
    parse: parseNumber,
  },
  {
    key: 'length',
    label: 'Length',
    title: 'Note length (PPQ, quarter notes)',
    display: (note) => formatPpq(note.durationPpq),
    parse: parseNumber,
  },
  {
    key: 'pitch',
    label: 'Pitch',
    title: 'Pitch as a note name (C#4) or MIDI number (61)',
    display: (note) => formatPitch(note.pitch),
    parse: parsePitch,
  },
  {
    key: 'velocity',
    label: 'Vel',
    title: 'Note-on velocity (1-127)',
    display: (note) => String(note.velocity),
    parse: parseInteger,
  },
  {
    key: 'channel',
    label: 'Ch',
    title: 'MIDI channel (1-16)',
    // Channels are stored 0-15 but displayed 1-16, the common DAW convention.
    display: (note) => String(note.channel + 1),
    parse: parseInteger,
  },
  {
    key: 'offVelocity',
    label: 'Off Vel',
    title: 'Note-off (release) velocity (1-127); empty = default release',
    display: (note) => (note.offVelocity !== undefined ? String(note.offVelocity) : ''),
    parse: parseInteger,
  },
];

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
  if (!anchor) {
    input.value = '';
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
  <div class="info-line" role="group" aria-label="Note info">
    <label v-for="field in fields" :key="field.key" class="info-line__field" :title="field.title">
      <span class="info-line__label">{{ field.label }}</span>
      <input
        class="info-line__input"
        type="text"
        spellcheck="false"
        autocomplete="off"
        :value="anchorNote ? field.display(anchorNote) : ''"
        :disabled="!anchorNote"
        :placeholder="anchorNote ? '' : '—'"
        :aria-label="field.title"
        @change="onCommit(field, $event)"
        @keydown.enter="onEnter"
        @keydown.esc="onEscape(field, $event)"
        @keydown.stop
      />
    </label>
    <span v-if="selectionCount > 1" class="info-line__count">{{ selectionCount }} notes</span>
  </div>
</template>

<style scoped>
.info-line {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.25rem 0.5rem;
  background: #1d2026;
  border-bottom: 1px solid #2c313a;
  font-size: 0.75rem;
  color: #aab2c0;
  user-select: none;
}

.info-line__field {
  display: flex;
  align-items: center;
  gap: 0.3rem;
}

.info-line__label {
  text-transform: uppercase;
  letter-spacing: 0.04em;
  font-size: 0.65rem;
  color: #6c7686;
}

.info-line__input {
  width: 4.5rem;
  padding: 0.15rem 0.3rem;
  background: #12141a;
  border: 1px solid #2c313a;
  border-radius: 3px;
  color: #dde3ec;
  font: inherit;
  font-variant-numeric: tabular-nums;
}

.info-line__input:focus {
  outline: none;
  border-color: #4a90d9;
}

.info-line__input:disabled {
  opacity: 0.45;
}

.info-line__count {
  margin-left: auto;
  color: #6c7686;
}
</style>

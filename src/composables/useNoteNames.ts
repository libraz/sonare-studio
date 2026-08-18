import { formatNote, type NoteData, type NoteNameSystem } from '@libraz/libcantus';
import { type ComputedRef, computed } from 'vue';
import { useAppSettings } from '@/composables/useAppSettings';
import {
  formatPitch,
  formatSpelledPitch,
  parsePitch,
  pitchClassNames as pitchClassNamesFor,
} from '@/lib/pitch';

/**
 * Note naming bound to the user's note-name-system preference.
 *
 * Display code calls these instead of the plain `@/lib/pitch` helpers so pitch
 * and key names follow the setting. Serialization, export and any name parsed
 * back keep calling the plain helpers, which name no system and so stay ASCII
 * English.
 *
 * Every accessor reads the preference when it is called, so calling one inside
 * a computed or a render function makes that effect track the setting; canvas
 * layers that repaint from an explicit watch list must add {@link
 * UseNoteNamesReturn.system} to it.
 */
export interface UseNoteNamesReturn {
  /** The selected note-name system. */
  system: ComputedRef<NoteNameSystem>;
  /** Pitch-class names (index 0 = C ... 11 = B) in the selected system. */
  pitchClassNames: ComputedRef<ReadonlyArray<string>>;
  /** Formats a MIDI note number with its octave, e.g. 61 → "C#4" / "嬰ハ4". */
  formatPitch(midi: number): string;
  /** Parses a typed pitch, accepting English names and the selected system. */
  parsePitch(text: string): number | null;
  /** Names an already-spelled pitch (step letter + alteration + octave). */
  formatSpelledPitch(spelled: Readonly<{ step: string; alter: number; octave?: number }>): string;
  /** Names a spelled note, such as the tonic of a detected key. */
  formatNoteName(note: NoteData): string;
}

/**
 * Vue composable exposing the note-name helpers for the selected system.
 *
 * Safe to call from any component or plain module code (no component scope
 * required), like the app-settings composable it reads.
 */
export function useNoteNames(): UseNoteNamesReturn {
  const appSettings = useAppSettings();
  const system = computed<NoteNameSystem>(() => appSettings.settings.noteNameSystem);
  const pitchClassNames = computed<ReadonlyArray<string>>(() => pitchClassNamesFor(system.value));
  return {
    system,
    pitchClassNames,
    formatPitch: (midi) => formatPitch(midi, system.value),
    parsePitch: (text) => parsePitch(text, system.value),
    formatSpelledPitch: (spelled) => formatSpelledPitch(spelled, system.value),
    formatNoteName: (note) => formatNote(note, { system: system.value }),
  };
}

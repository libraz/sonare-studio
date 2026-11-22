import type { ComputedRef, Ref } from 'vue';
import { computed, getCurrentScope, onScopeDispose, ref } from 'vue';
import { clamp } from '@/lib/math';
import { DEFAULT_NOTE_VELOCITY } from '@/lib/midi';
import { isEditableTarget } from '@/ui/keyboard';
import { shortcutBlockingOverlayOpen } from '@/ui/overlay-registry';
import type { StepInputHandle } from './useStepInput';

/**
 * Pitch offset from the base-octave C for each QWERTY note key.
 * The home row a s d f g h j k plays the white keys C D E F G A B C(+1),
 * and w e t y u play the black keys in between.
 */
const KEY_TO_OFFSET: Readonly<Record<string, number>> = {
  a: 0,
  w: 1,
  s: 2,
  e: 3,
  d: 4,
  f: 5,
  t: 6,
  g: 7,
  y: 8,
  h: 9,
  u: 10,
  j: 11,
  k: 12,
};

const OCTAVE_DOWN_KEY = 'z';
const OCTAVE_UP_KEY = 'x';
const VELOCITY_DOWN_KEY = 'c';
const VELOCITY_UP_KEY = 'v';
const REST_KEY = 'tab';

/**
 * Plain and Shift-modified versions of these keys are consumed while music
 * typing is enabled. The shortcuts settings use this to flag unreachable
 * user bindings before they are saved.
 */
export const MUSIC_TYPING_RESERVED_KEYS: Readonly<Record<string, string>> = {
  ...Object.fromEntries(Object.keys(KEY_TO_OFFSET).map((key) => [key, 'typing.notes'])),
  [OCTAVE_DOWN_KEY]: 'typing.octave',
  [OCTAVE_UP_KEY]: 'typing.octave',
  [VELOCITY_DOWN_KEY]: 'typing.velocity',
  [VELOCITY_UP_KEY]: 'typing.velocity',
  [REST_KEY]: 'typing.rest',
};

/** Lowest selectable base octave ('a' = C-1 = MIDI 0). */
export const MIN_BASE_OCTAVE = -1;
/** Highest selectable base octave (keys above G9 = MIDI 127 are ignored). */
export const MAX_BASE_OCTAVE = 9;
/** Velocity change applied per velocity-down / velocity-up key press. */
export const VELOCITY_STEP = 10;

const DEFAULT_BASE_OCTAVE = 4;

/** Note-on emitted when a note key goes down. */
export interface MusicTypingNoteOnEvent {
  /** MIDI note number (0-127). */
  pitch: number;
  /** Note-on velocity (1-127), the handle's current typing velocity. */
  velocity: number;
}

/** Note-off emitted when a note key is released (or all keys are flushed). */
export interface MusicTypingNoteOffEvent {
  /** MIDI note number (0-127). */
  pitch: number;
}

/** The slice of a step-input handle music typing writes through while armed. */
export type MusicTypingStepTarget = Pick<StepInputHandle, 'armed' | 'enterNote' | 'rest' | 'back'>;

/** Options for {@link useMusicTyping}. */
export interface UseMusicTypingOptions {
  /** Called on key down of a note key (wire this to an audible preview). */
  onNoteOn?: (event: MusicTypingNoteOnEvent) => void;
  /** Called on key up of a held note key, on disable(), and on window blur. */
  onNoteOff?: (event: MusicTypingNoteOffEvent) => void;
  /**
   * Step-input handle; while it is armed, every note key down also writes a
   * note at the step cursor (which then advances), and Tab enters a rest.
   */
  stepInput?: MusicTypingStepTarget;
  /** Event target the key listeners attach to (default: window). */
  target?: EventTarget;
}

/** Reactive state and controls returned by {@link useMusicTyping}. */
export interface MusicTypingHandle {
  /** True while the key listeners are attached. */
  enabled: ComputedRef<boolean>;
  /** Octave of the 'a' key's C; clamped to [-1, 9] by the octave keys. */
  baseOctave: Ref<number>;
  /** Velocity used for emitted note-ons (1-127), stepped by the velocity keys. */
  velocity: Ref<number>;
  /** Pitches currently held down, in press order. */
  activePitches: ComputedRef<number[]>;
  /** Attaches the key listeners. Idempotent. */
  enable(): void;
  /** Detaches the key listeners and releases all held notes. Idempotent. */
  disable(): void;
}

/** Clamps a value into [min, max]. */

/**
 * Vue composable implementing QWERTY musical typing (keyboard → MIDI notes).
 *
 * While enabled, note key downs emit {@link UseMusicTypingOptions.onNoteOn}
 * and key ups emit onNoteOff, so the app can route them to a live preview
 * instrument. Auto-repeat is ignored; modifier chords (Ctrl/Meta/Alt) and key
 * events originating from editable elements pass through untouched. When the
 * injected step input is armed, each note key down additionally writes a note
 * at the step cursor through the project commands.
 *
 * Listeners are detached automatically when the owning effect scope disposes.
 *
 * @param options Callbacks, optional step-input handle, and event target.
 * @returns Reactive typing state and enable/disable controls.
 */
export function useMusicTyping(options: UseMusicTypingOptions = {}): MusicTypingHandle {
  const target = options.target ?? window;
  const enabled = ref(false);
  const baseOctave = ref(DEFAULT_BASE_OCTAVE);
  const velocity = ref(DEFAULT_NOTE_VELOCITY);
  /** Held note keys → the pitch their note-on was emitted with. */
  const held = ref<ReadonlyMap<string, number>>(new Map());

  const activePitches = computed(() => [...held.value.values()]);

  function releaseAll(): void {
    if (held.value.size === 0) return;
    const releasing = [...held.value.values()];
    held.value = new Map();
    for (const pitch of releasing) {
      options.onNoteOff?.({ pitch });
    }
  }

  function handleKeyDown(event: Event): void {
    const e = event as KeyboardEvent;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (isEditableTarget(e.target)) return;
    if (shortcutBlockingOverlayOpen.value) return;
    const key = e.key.toLowerCase();

    if (key === REST_KEY) {
      if (options.stepInput?.armed.value) {
        e.preventDefault();
        if (e.shiftKey) options.stepInput.back();
        else options.stepInput.rest();
      }
      return;
    }
    if (key === OCTAVE_DOWN_KEY || key === OCTAVE_UP_KEY) {
      e.preventDefault();
      const delta = key === OCTAVE_UP_KEY ? 1 : -1;
      baseOctave.value = clamp(baseOctave.value + delta, MIN_BASE_OCTAVE, MAX_BASE_OCTAVE);
      return;
    }
    if (key === VELOCITY_DOWN_KEY || key === VELOCITY_UP_KEY) {
      e.preventDefault();
      const delta = key === VELOCITY_UP_KEY ? VELOCITY_STEP : -VELOCITY_STEP;
      velocity.value = clamp(velocity.value + delta, 1, 127);
      return;
    }

    const offset = KEY_TO_OFFSET[key];
    if (offset === undefined) return;
    e.preventDefault();
    if (e.repeat || held.value.has(key)) return;
    const pitch = (baseOctave.value + 1) * 12 + offset;
    if (pitch < 0 || pitch > 127) return;
    const next = new Map(held.value);
    next.set(key, pitch);
    held.value = next;
    options.onNoteOn?.({ pitch, velocity: velocity.value });
    if (options.stepInput?.armed.value) {
      options.stepInput.enterNote(pitch, velocity.value);
    }
  }

  function handleKeyUp(event: Event): void {
    const e = event as KeyboardEvent;
    const key = e.key.toLowerCase();
    const pitch = held.value.get(key);
    if (pitch === undefined) return;
    const next = new Map(held.value);
    next.delete(key);
    held.value = next;
    options.onNoteOff?.({ pitch });
  }

  /** Releases held notes when the window loses focus, so no note hangs. */
  function handleBlur(): void {
    releaseAll();
  }

  function enable(): void {
    if (enabled.value) return;
    target.addEventListener('keydown', handleKeyDown);
    target.addEventListener('keyup', handleKeyUp);
    target.addEventListener('blur', handleBlur);
    enabled.value = true;
  }

  function disable(): void {
    if (!enabled.value) return;
    target.removeEventListener('keydown', handleKeyDown);
    target.removeEventListener('keyup', handleKeyUp);
    target.removeEventListener('blur', handleBlur);
    enabled.value = false;
    releaseAll();
  }

  if (getCurrentScope()) {
    onScopeDispose(disable);
  }

  return {
    enabled: computed(() => enabled.value),
    baseOctave,
    velocity,
    activePitches,
    enable,
    disable,
  };
}

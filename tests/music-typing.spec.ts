import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import {
  MAX_BASE_OCTAVE,
  MIN_BASE_OCTAVE,
  type MusicTypingHandle,
  type MusicTypingStepTarget,
  useMusicTyping,
  VELOCITY_STEP,
} from '@/composables/useMusicTyping';
import {
  resetShortcutBlockingOverlaysForTest,
  useShortcutBlockingOverlay,
} from '@/ui/overlay-registry';

/** Dispatches a keyboard event on window (or bubbled from a given target). */
function press(key: string, init: KeyboardEventInit = {}, target: EventTarget = window): void {
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init }));
}

function release(key: string, target: EventTarget = window): void {
  target.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }));
}

describe('useMusicTyping', () => {
  const onNoteOn = vi.fn();
  const onNoteOff = vi.fn();
  let handle: MusicTypingHandle;

  beforeEach(() => {
    resetShortcutBlockingOverlaysForTest();
    onNoteOn.mockClear();
    onNoteOff.mockClear();
    handle = useMusicTyping({ onNoteOn, onNoteOff });
    handle.enable();
  });

  afterEach(() => {
    handle.disable();
    resetShortcutBlockingOverlaysForTest();
    document.body.replaceChildren();
  });

  it('maps the home row to white keys from the base octave', () => {
    // a..k = C D E F G A B C with base octave 4 (a = C4 = 60).
    const expected: Array<[string, number]> = [
      ['a', 60],
      ['s', 62],
      ['d', 64],
      ['f', 65],
      ['g', 67],
      ['h', 69],
      ['j', 71],
      ['k', 72],
    ];
    for (const [key, pitch] of expected) {
      press(key);
      expect(onNoteOn).toHaveBeenLastCalledWith({ pitch, velocity: 96 });
      release(key);
    }
    expect(onNoteOn).toHaveBeenCalledTimes(expected.length);
  });

  it('maps w/e/t/y/u to black keys', () => {
    const expected: Array<[string, number]> = [
      ['w', 61],
      ['e', 63],
      ['t', 66],
      ['y', 68],
      ['u', 70],
    ];
    for (const [key, pitch] of expected) {
      press(key);
      expect(onNoteOn).toHaveBeenLastCalledWith({ pitch, velocity: 96 });
      release(key);
    }
  });

  it('emits note-off with the pitch the note-on used', () => {
    press('a');
    release('a');
    expect(onNoteOff).toHaveBeenCalledWith({ pitch: 60 });
  });

  it('tracks held pitches while keys are down', () => {
    press('a');
    press('d');
    expect(handle.activePitches.value).toEqual([60, 64]);
    release('a');
    expect(handle.activePitches.value).toEqual([64]);
    release('d');
    expect(handle.activePitches.value).toEqual([]);
  });

  it('ignores auto-repeat and double key-down without keyup', () => {
    press('a');
    press('a', { repeat: true });
    press('a');
    expect(onNoteOn).toHaveBeenCalledTimes(1);
  });

  it('uses the original pitch for note-off after an octave change while held', () => {
    press('a');
    press('x'); // octave up while 'a' is held
    release('a');
    expect(onNoteOff).toHaveBeenCalledWith({ pitch: 60 });
  });

  it('shifts the base octave with z/x and clamps it', () => {
    press('x');
    expect(handle.baseOctave.value).toBe(5);
    press('a');
    expect(onNoteOn).toHaveBeenLastCalledWith({ pitch: 72, velocity: 96 });
    release('a');
    for (let i = 0; i < 20; i++) press('z');
    expect(handle.baseOctave.value).toBe(MIN_BASE_OCTAVE);
    for (let i = 0; i < 20; i++) press('x');
    expect(handle.baseOctave.value).toBe(MAX_BASE_OCTAVE);
  });

  it('skips notes that fall outside the MIDI range at the top octave', () => {
    for (let i = 0; i < 20; i++) press('x');
    press('a'); // C9 = 120, valid
    expect(onNoteOn).toHaveBeenLastCalledWith({ pitch: 120, velocity: 96 });
    press('k'); // C10 = 132, out of range
    expect(onNoteOn).toHaveBeenCalledTimes(1);
  });

  it('steps velocity with c/v and clamps to [1, 127]', () => {
    press('v');
    expect(handle.velocity.value).toBe(96 + VELOCITY_STEP);
    for (let i = 0; i < 30; i++) press('v');
    expect(handle.velocity.value).toBe(127);
    for (let i = 0; i < 30; i++) press('c');
    expect(handle.velocity.value).toBe(1);
    press('a');
    expect(onNoteOn).toHaveBeenLastCalledWith({ pitch: 60, velocity: 1 });
  });

  it('ignores key events with command modifiers', () => {
    press('a', { metaKey: true });
    press('a', { ctrlKey: true });
    press('a', { altKey: true });
    expect(onNoteOn).not.toHaveBeenCalled();
  });

  it('ignores note keys while a shortcut-blocking overlay is open', () => {
    useShortcutBlockingOverlay(ref(true));

    press('a');

    expect(onNoteOn).not.toHaveBeenCalled();
  });

  it('ignores key events originating from editable elements', () => {
    const input = document.createElement('input');
    const textarea = document.createElement('textarea');
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    document.body.append(input, textarea, editable);
    press('a', {}, input);
    press('a', {}, textarea);
    press('a', {}, editable);
    expect(onNoteOn).not.toHaveBeenCalled();
  });

  it('releases all held notes on disable()', () => {
    press('a');
    press('s');
    handle.disable();
    expect(onNoteOff).toHaveBeenCalledWith({ pitch: 60 });
    expect(onNoteOff).toHaveBeenCalledWith({ pitch: 62 });
    expect(handle.activePitches.value).toEqual([]);
    expect(handle.enabled.value).toBe(false);
  });

  it('does nothing while disabled', () => {
    handle.disable();
    press('a');
    expect(onNoteOn).not.toHaveBeenCalled();
  });

  it('releases held notes when the window loses focus', () => {
    press('a');
    window.dispatchEvent(new Event('blur'));
    expect(onNoteOff).toHaveBeenCalledWith({ pitch: 60 });
    expect(handle.activePitches.value).toEqual([]);
  });
});

describe('useMusicTyping step-input integration', () => {
  beforeEach(() => {
    resetShortcutBlockingOverlaysForTest();
  });

  afterEach(() => {
    resetShortcutBlockingOverlaysForTest();
  });

  function makeStepTarget(armed: boolean): MusicTypingStepTarget {
    return {
      armed: ref(armed),
      enterNote: vi.fn(() => 1),
      rest: vi.fn(),
      back: vi.fn(),
    };
  }

  it('writes each typed note through the step input while armed', () => {
    const stepInput = makeStepTarget(true);
    const handle = useMusicTyping({ stepInput });
    handle.enable();
    press('a');
    press('w');
    expect(stepInput.enterNote).toHaveBeenNthCalledWith(1, 60, 96);
    expect(stepInput.enterNote).toHaveBeenNthCalledWith(2, 61, 96);
    handle.disable();
  });

  it('enters a rest via Tab while armed', () => {
    const stepInput = makeStepTarget(true);
    const handle = useMusicTyping({ stepInput });
    handle.enable();
    press('Tab');
    expect(stepInput.rest).toHaveBeenCalledTimes(1);
    handle.disable();
  });

  it('moves the step-input cursor back via Shift+Tab while armed', () => {
    const stepInput = makeStepTarget(true);
    const handle = useMusicTyping({ stepInput });
    handle.enable();
    press('Tab', { shiftKey: true });
    expect(stepInput.back).toHaveBeenCalledTimes(1);
    expect(stepInput.rest).not.toHaveBeenCalled();
    handle.disable();
  });

  it('blocks step-input notes and rests while a shortcut-blocking overlay is open', () => {
    const stepInput = makeStepTarget(true);
    const handle = useMusicTyping({ stepInput });
    useShortcutBlockingOverlay(ref(true));
    handle.enable();

    press('a');
    press('Tab');

    expect(stepInput.enterNote).not.toHaveBeenCalled();
    expect(stepInput.rest).not.toHaveBeenCalled();
    handle.disable();
  });

  it('does not write through the step input while disarmed', () => {
    const stepInput = makeStepTarget(false);
    const handle = useMusicTyping({ stepInput });
    handle.enable();
    press('a');
    press('Tab');
    expect(stepInput.enterNote).not.toHaveBeenCalled();
    expect(stepInput.rest).not.toHaveBeenCalled();
    handle.disable();
  });

  it('reflects armed-state changes made after setup', () => {
    const armed = ref(false);
    const stepInput: MusicTypingStepTarget = {
      armed,
      enterNote: vi.fn(() => 1),
      rest: vi.fn(),
      back: vi.fn(),
    };
    const handle = useMusicTyping({ stepInput });
    handle.enable();
    press('a');
    expect(stepInput.enterNote).not.toHaveBeenCalled();
    release('a');
    armed.value = true;
    press('a');
    expect(stepInput.enterNote).toHaveBeenCalledWith(60, 96);
    handle.disable();
  });
});

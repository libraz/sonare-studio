import { describe, expect, it } from 'vitest';
import {
  comboFromEvent,
  comboMatchesEvent,
  combosMatch,
  comboToString,
  formatKeyCombo,
  normalizeComboString,
  parseKeyCombo,
} from '@/ui/settings/key-combo';

function keydown(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent('keydown', init);
}

describe('parseKeyCombo', () => {
  it('parses a plain key', () => {
    expect(parseKeyCombo('q')).toEqual({ key: 'q', mod: false, shift: false, alt: false });
  });

  it('parses modifiers in any order and case', () => {
    expect(parseKeyCombo('Shift+Mod+Z')).toEqual({
      key: 'z',
      mod: true,
      shift: true,
      alt: false,
    });
  });

  it('accepts cmd, meta, ctrl and control as mod aliases', () => {
    for (const alias of ['cmd', 'meta', 'ctrl', 'control']) {
      expect(parseKeyCombo(`${alias}+s`)?.mod).toBe(true);
    }
  });

  it('accepts option as an alt alias', () => {
    expect(parseKeyCombo('option+a')?.alt).toBe(true);
  });

  it('normalizes named-key aliases', () => {
    expect(parseKeyCombo('Esc')?.key).toBe('escape');
    expect(parseKeyCombo('Up')?.key).toBe('arrowup');
    expect(parseKeyCombo(' ')).toBeNull(); // Bare whitespace is empty input.
    expect(parseKeyCombo('space')?.key).toBe('space');
    expect(parseKeyCombo('return')?.key).toBe('enter');
  });

  it('parses a trailing plus as the plus key', () => {
    expect(parseKeyCombo('mod++')).toEqual({ key: '+', mod: true, shift: false, alt: false });
  });

  it('rejects empty text, unknown modifiers and modifier-only combos', () => {
    expect(parseKeyCombo('')).toBeNull();
    expect(parseKeyCombo('hyper+x')).toBeNull();
    expect(parseKeyCombo('shift')).toBeNull();
    expect(parseKeyCombo('mod+shift')).toBeNull();
  });
});

describe('comboToString / normalizeComboString', () => {
  it('serializes in canonical mod+alt+shift+key order', () => {
    expect(normalizeComboString('shift+alt+ctrl+K')).toBe('mod+alt+shift+k');
  });

  it('round-trips through parse', () => {
    const combo = parseKeyCombo('mod+shift+z');
    expect(combo).not.toBeNull();
    expect(comboToString(combo!)).toBe('mod+shift+z');
  });

  it('returns null for unparseable text', () => {
    expect(normalizeComboString('nope+x')).toBeNull();
  });
});

describe('formatKeyCombo', () => {
  it('uses mac symbols in system order on mac', () => {
    expect(formatKeyCombo('mod+shift+z', 'mac')).toBe('⇧⌘Z');
    expect(formatKeyCombo('alt+mod+d', 'mac')).toBe('⌥⌘D');
  });

  it('uses Ctrl+Alt+Shift words elsewhere', () => {
    expect(formatKeyCombo('mod+shift+z', 'other')).toBe('Ctrl+Shift+Z');
    expect(formatKeyCombo('alt+d', 'other')).toBe('Alt+D');
  });

  it('labels named keys', () => {
    expect(formatKeyCombo('space', 'other')).toBe('Space');
    expect(formatKeyCombo('mod+arrowup', 'other')).toBe('Ctrl+↑');
    expect(formatKeyCombo('escape', 'mac')).toBe('Esc');
  });

  it('returns unparseable strings verbatim', () => {
    expect(formatKeyCombo('A W S D', 'mac')).toBe('A W S D');
  });
});

describe('comboFromEvent', () => {
  it('captures key and modifiers', () => {
    const combo = comboFromEvent(keydown({ key: 'Z', ctrlKey: true, shiftKey: true }), 'other');
    expect(combo).toEqual({ key: 'z', mod: true, shift: true, alt: false });
  });

  it('uses Cmd on macOS and Ctrl elsewhere for mod', () => {
    expect(comboFromEvent(keydown({ key: 'd', metaKey: true }), 'mac')?.mod).toBe(true);
    expect(comboFromEvent(keydown({ key: 'd', ctrlKey: true }), 'other')?.mod).toBe(true);
    expect(comboFromEvent(keydown({ key: 'd', metaKey: true }), 'other')?.mod).toBe(false);
  });

  it('returns null for modifier-only presses', () => {
    expect(comboFromEvent(keydown({ key: 'Shift', shiftKey: true }))).toBeNull();
    expect(comboFromEvent(keydown({ key: 'Meta', metaKey: true }))).toBeNull();
  });

  it('normalizes the space key', () => {
    expect(comboFromEvent(keydown({ key: ' ' }))?.key).toBe('space');
  });
});

describe('comboMatchesEvent / combosMatch', () => {
  it('matches mod against the platform command modifier only', () => {
    expect(comboMatchesEvent('mod+s', keydown({ key: 's', metaKey: true }), 'mac')).toBe(true);
    expect(comboMatchesEvent('mod+s', keydown({ key: 's', ctrlKey: true }), 'other')).toBe(true);
    expect(comboMatchesEvent('mod+s', keydown({ key: 's', metaKey: true }), 'other')).toBe(false);
  });

  it('distinguishes shift on letters', () => {
    expect(
      comboMatchesEvent('mod+z', keydown({ key: 'z', ctrlKey: true, shiftKey: true }), 'other'),
    ).toBe(false);
    expect(
      comboMatchesEvent(
        'mod+shift+z',
        keydown({ key: 'z', ctrlKey: true, shiftKey: true }),
        'other',
      ),
    ).toBe(true);
  });

  it('ignores shift for shifted punctuation like ?', () => {
    // US layouts produce '?' with Shift held; the binding stores no shift.
    expect(comboMatchesEvent('?', keydown({ key: '?', shiftKey: true }))).toBe(true);
    expect(comboMatchesEvent('?', keydown({ key: '?' }))).toBe(true);
  });

  it('requires alt to match exactly', () => {
    const a = parseKeyCombo('alt+f')!;
    const b = parseKeyCombo('f')!;
    expect(combosMatch(a, b)).toBe(false);
  });

  it('returns false for unparseable combo text', () => {
    expect(comboMatchesEvent('bogus+key', keydown({ key: 'k' }))).toBe(false);
  });
});

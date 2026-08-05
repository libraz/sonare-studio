import { describe, expect, it } from 'vitest';
import {
  bankSlotTrackId,
  bankWindow,
  clampBankOffset,
  controlSurfaceSettingsAreDefault,
  defaultControlSurfaceSettings,
  nextBankOffset,
  previousBankOffset,
  sanitizeControlSurfaceSettings,
} from '@/project/control-surface';

const TRACKS = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19];

describe('bank window', () => {
  it('maps eight slots onto the tracks under the window', () => {
    expect(bankWindow(TRACKS, 0, 8)).toEqual([10, 11, 12, 13, 14, 15, 16, 17]);
    expect(bankWindow(TRACKS, 2, 8)).toEqual([12, 13, 14, 15, 16, 17, 18, 19]);
  });

  it('leaves slots past the last track inert instead of wrapping', () => {
    // A surface wider than the session must not drive a track the user is not
    // looking at; the extra strips simply address nothing.
    expect(bankWindow([1, 2], 0, 4)).toEqual([1, 2, null, null]);
    expect(bankSlotTrackId([1, 2], 0, 4, 3)).toBeNull();
    expect(bankSlotTrackId([1, 2], 0, 4, 0)).toBe(1);
  });

  it('keeps the last page full rather than running off the end', () => {
    // 10 tracks, 8 strips: the furthest useful offset is 2, not 8.
    expect(clampBankOffset(8, TRACKS.length, 8)).toBe(2);
    expect(nextBankOffset(0, TRACKS.length, 8)).toBe(2);
    expect(nextBankOffset(2, TRACKS.length, 8)).toBe(2);
    expect(previousBankOffset(2, TRACKS.length, 8)).toBe(0);
    expect(previousBankOffset(0, TRACKS.length, 8)).toBe(0);
  });

  it('collapses the window when the session is smaller than the surface', () => {
    expect(clampBankOffset(5, 3, 8)).toBe(0);
    expect(nextBankOffset(0, 3, 8)).toBe(0);
    expect(bankWindow([], 4, 2)).toEqual([null, null]);
  });

  it('pages by the configured surface width', () => {
    expect(nextBankOffset(0, TRACKS.length, 4)).toBe(4);
    expect(nextBankOffset(4, TRACKS.length, 4)).toBe(6);
    expect(previousBankOffset(6, TRACKS.length, 4)).toBe(2);
  });
});

describe('control-surface settings', () => {
  it('starts with no surface configured', () => {
    const defaults = defaultControlSurfaceSettings();
    expect(defaults.protocol).toBe('none');
    expect(defaults.bankSize).toBe(8);
    expect(defaults.feedback).toBe(false);
    expect(controlSurfaceSettingsAreDefault(defaults)).toBe(true);
    expect(controlSurfaceSettingsAreDefault({ ...defaults, protocol: 'mcu' })).toBe(false);
    expect(controlSurfaceSettingsAreDefault({ ...defaults, outputPortId: 'out-1' })).toBe(false);
  });

  it('falls back field by field so one bad value keeps the rest', () => {
    expect(
      sanitizeControlSurfaceSettings({
        protocol: 'hui',
        bankSize: 'wide',
        bankOffset: -4,
        inputPortId: 'in-1',
        outputPortId: '',
        feedback: 'yes',
      }),
    ).toEqual({
      protocol: 'hui',
      bankSize: 8,
      bankOffset: 0,
      inputPortId: 'in-1',
      outputPortId: null,
      feedback: false,
    });
  });

  it('bounds the surface width and rejects unknown protocols', () => {
    expect(sanitizeControlSurfaceSettings({ bankSize: 999 }).bankSize).toBe(32);
    expect(sanitizeControlSurfaceSettings({ bankSize: 0 }).bankSize).toBe(1);
    expect(sanitizeControlSurfaceSettings({ protocol: 'eucon' }).protocol).toBe('none');
    expect(sanitizeControlSurfaceSettings(null)).toEqual(defaultControlSurfaceSettings());
    expect(sanitizeControlSurfaceSettings('mcu')).toEqual(defaultControlSurfaceSettings());
  });
});

import { describe, expect, it } from 'vitest';
import {
  createHistory,
  currentVersion,
  editedAssetName,
  pushVersion,
  selectVersion,
} from '@/ui/sample-editor/history';

describe('version history', () => {
  it('starts with the initial version selected', () => {
    const state = createHistory({ assetId: 'a', label: 'Original' });
    expect(state.versions).toHaveLength(1);
    expect(state.currentIndex).toBe(0);
    expect(currentVersion(state)).toEqual({ assetId: 'a', label: 'Original' });
  });

  it('pushVersion appends after the current version and selects it', () => {
    let state = createHistory({ assetId: 'a', label: 'Original' });
    state = pushVersion(state, { assetId: 'b', label: 'Gain 3 dB' });
    state = pushVersion(state, { assetId: 'c', label: 'Reverse' });
    expect(state.versions.map((v) => v.assetId)).toEqual(['a', 'b', 'c']);
    expect(currentVersion(state).assetId).toBe('c');
  });

  it('pushVersion after a jump back drops the newer versions', () => {
    let state = createHistory({ assetId: 'a', label: 'Original' });
    state = pushVersion(state, { assetId: 'b', label: 'Gain' });
    state = pushVersion(state, { assetId: 'c', label: 'Reverse' });
    state = selectVersion(state, 0);
    state = pushVersion(state, { assetId: 'd', label: 'Fade in' });
    expect(state.versions.map((v) => v.assetId)).toEqual(['a', 'd']);
    expect(currentVersion(state).assetId).toBe('d');
  });

  it('pushVersion is a no-op for the current asset id (unchanged content)', () => {
    const state = pushVersion(createHistory({ assetId: 'a', label: 'Original' }), {
      assetId: 'a',
      label: 'Silence',
    });
    expect(state.versions).toHaveLength(1);
    expect(pushVersion(state, { assetId: 'a', label: 'Again' })).toBe(state);
  });

  it('a previously dropped id can reappear as a new version', () => {
    let state = createHistory({ assetId: 'a', label: 'Original' });
    state = pushVersion(state, { assetId: 'b', label: 'Gain +3 dB' });
    state = pushVersion(state, { assetId: 'a', label: 'Gain -3 dB' });
    expect(state.versions.map((v) => v.assetId)).toEqual(['a', 'b', 'a']);
    expect(state.currentIndex).toBe(2);
  });

  it('selectVersion jumps without changing the list', () => {
    let state = createHistory({ assetId: 'a', label: 'Original' });
    state = pushVersion(state, { assetId: 'b', label: 'Gain' });
    const jumped = selectVersion(state, 0);
    expect(jumped.versions).toBe(state.versions);
    expect(currentVersion(jumped).assetId).toBe('a');
    expect(selectVersion(jumped, 0)).toBe(jumped); // same index: same state
  });

  it('selectVersion rejects out-of-bounds indices', () => {
    const state = createHistory({ assetId: 'a', label: 'Original' });
    expect(() => selectVersion(state, -1)).toThrow(RangeError);
    expect(() => selectVersion(state, 1)).toThrow(RangeError);
    expect(() => selectVersion(state, 0.5)).toThrow(RangeError);
  });
});

describe('editedAssetName', () => {
  it('appends the edited suffix once', () => {
    expect(editedAssetName('Kick')).toBe('Kick (edited)');
    expect(editedAssetName('Kick (edited)')).toBe('Kick (edited)');
  });
});

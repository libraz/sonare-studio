import { HARMONIC_MINOR_MASK, MAJOR_MASK } from '@libraz/libcantus';
import { describe, expect, it } from 'vitest';
import { buildKeyMap, sameKeyName } from '@/compose/key-map';
import { keyMarkerName } from '@/compose/key-name';
import { type EditorMarker, MAJOR_MODE_MASK, type ScaleHighlightConfig } from '@/project/types';

function marker(partial: Partial<EditorMarker>): EditorMarker {
  return { id: 1, ppq: 0, name: 'Marker', ...partial };
}

const C_MAJOR: ScaleHighlightConfig = { enabled: true, rootPc: 0, modeMask: MAJOR_MODE_MASK };
const A_HARMONIC_MINOR: ScaleHighlightConfig = {
  enabled: true,
  rootPc: 9,
  modeMask: HARMONIC_MINOR_MASK,
};

describe('buildKeyMap', () => {
  it('applies the declared key everywhere when there are no markers', () => {
    const km = buildKeyMap(C_MAJOR, []);
    expect(km.regions).toEqual([
      {
        startPpq: 0,
        endPpq: Infinity,
        key: { rootPc: 0, modeMask12: MAJOR_MODE_MASK },
        source: 'declared',
      },
    ]);
    expect(km.at(0)).toEqual({ rootPc: 0, modeMask12: MAJOR_MODE_MASK });
    expect(km.at(999_999)).toEqual({ rootPc: 0, modeMask12: MAJOR_MODE_MASK });
  });

  it('applies a marker at beat 0 immediately, with no separate declared region', () => {
    const km = buildKeyMap(C_MAJOR, [
      marker({ id: 1, ppq: 0, name: keyMarkerName(1, false) }), // G major
    ]);
    expect(km.regions).toHaveLength(1);
    expect(km.regions[0]).toMatchObject({ startPpq: 0, endPpq: Infinity, source: 'marker' });
    expect(km.at(0)).toEqual({ rootPc: 7, modeMask12: MAJOR_MASK });
  });

  it('splits a declared region before the first marker from a marker region after it', () => {
    const km = buildKeyMap(C_MAJOR, [
      marker({ id: 1, ppq: 960, name: keyMarkerName(1, false) }), // G major
    ]);
    expect(km.regions).toEqual([
      {
        startPpq: 0,
        endPpq: 960,
        key: { rootPc: 0, modeMask12: MAJOR_MODE_MASK },
        source: 'declared',
      },
      {
        startPpq: 960,
        endPpq: Infinity,
        key: { rootPc: 7, modeMask12: MAJOR_MASK },
        source: 'marker',
      },
    ]);
    expect(km.at(500)).toEqual({ rootPc: 0, modeMask12: MAJOR_MODE_MASK });
    expect(km.at(960)).toEqual({ rootPc: 7, modeMask12: MAJOR_MASK });
    expect(km.at(2000)).toEqual({ rootPc: 7, modeMask12: MAJOR_MASK });
  });

  it('keeps the marker with the larger id when two markers share a position', () => {
    const km = buildKeyMap(C_MAJOR, [
      marker({ id: 5, ppq: 960, name: keyMarkerName(1, false) }), // G major
      marker({ id: 9, ppq: 960, name: keyMarkerName(-1, false) }), // F major, larger id wins
    ]);
    expect(km.regions).toHaveLength(2);
    expect(km.at(960)).toEqual({ rootPc: 5, modeMask12: MAJOR_MASK });
  });

  it('applies a Key marker regardless of scale highlighting being disabled', () => {
    const disabled: ScaleHighlightConfig = { ...C_MAJOR, enabled: false };
    const km = buildKeyMap(disabled, [
      marker({ id: 1, ppq: 480, name: keyMarkerName(2, false) }), // D major
    ]);
    expect(km.at(0)).toBeNull();
    expect(km.at(480)).toEqual({ rootPc: 2, modeMask12: MAJOR_MASK });
  });

  it('keeps the declared harmonic-minor mask when a marker restates the same tonic', () => {
    const km = buildKeyMap(A_HARMONIC_MINOR, [
      marker({ id: 1, ppq: 960, name: keyMarkerName(0, true) }), // A minor
    ]);
    expect(km.at(0)).toEqual({ rootPc: 9, modeMask12: HARMONIC_MINOR_MASK });
    // A plain "Key: A minor" marker would otherwise read as natural minor;
    // the same-tonic declared mask is kept instead.
    expect(km.at(960)).toEqual({ rootPc: 9, modeMask12: HARMONIC_MINOR_MASK });
  });

  it('keyFifthsAt reads the region key signature, using the marker fifths as-is', () => {
    const km = buildKeyMap(C_MAJOR, [
      marker({ id: 1, ppq: 960, name: keyMarkerName(1, false) }), // G major
    ]);
    expect(km.keyFifthsAt(0)).toBe(0); // declared C major
    expect(km.keyFifthsAt(960)).toBe(1); // marker's own fifths
  });

  it('keyFifthsAt returns 0 when no key is set for the region', () => {
    const disabled: ScaleHighlightConfig = { ...C_MAJOR, enabled: false };
    const km = buildKeyMap(disabled, []);
    expect(km.keyFifthsAt(0)).toBe(0);
  });

  it('keySetAt distinguishes a set key from an absent one', () => {
    const disabled: ScaleHighlightConfig = { ...C_MAJOR, enabled: false };
    const km = buildKeyMap(disabled, [
      marker({ id: 1, ppq: 480, name: keyMarkerName(2, false) }), // D major
    ]);
    expect(km.keySetAt(0)).toBe(false);
    expect(km.keySetAt(480)).toBe(true);
  });

  it('leaves the final region open-ended (endPpq = Infinity)', () => {
    const noMarkers = buildKeyMap(C_MAJOR, []);
    expect(noMarkers.regions.at(-1)?.endPpq).toBe(Infinity);

    const withMarkers = buildKeyMap(C_MAJOR, [
      marker({ id: 1, ppq: 480, name: keyMarkerName(2, false) }),
      marker({ id: 2, ppq: 960, name: keyMarkerName(1, false) }),
    ]);
    expect(withMarkers.regions.at(-1)?.endPpq).toBe(Infinity);
  });
});

describe('sameKeyName', () => {
  it('matches on tonic pitch class and major/minor, ignoring the rest of the mode', () => {
    expect(
      sameKeyName(
        { rootPc: 9, modeMask12: HARMONIC_MINOR_MASK },
        { rootPc: 9, modeMask12: 1453 }, // natural minor
      ),
    ).toBe(true);
    expect(
      sameKeyName(
        { rootPc: 9, modeMask12: HARMONIC_MINOR_MASK },
        { rootPc: 0, modeMask12: MAJOR_MASK },
      ),
    ).toBe(false);
  });
});

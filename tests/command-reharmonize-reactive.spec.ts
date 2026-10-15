import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setProjectChords } from '@/project/command/chords';
import { clearHistory, undo } from '@/project/command/history';
import { addNote } from '@/project/command/notes';
import {
  applyReharmonizationProposal,
  proposeReharmonizationForActiveClip,
} from '@/project/command/reharmonize-reactive';
import { setTrackPercussion } from '@/project/command/tracks';
import { useProjectStore } from '@/project/store';
import { MAJOR_MODE_MASK } from '@/project/types';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

describe('reactive reharmonization commands', () => {
  let store: ReturnType<typeof useProjectStore>;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
    store.scaleHighlight = { enabled: true, rootPc: 0, modeMask: MAJOR_MODE_MASK };
  });

  /** Writes a C-major arpeggio across the first bar of the active clip. */
  function addCMajorArpeggio(): void {
    addNote({ pitch: 60, startPpq: 0, durationPpq: 1 });
    addNote({ pitch: 64, startPpq: 1, durationPpq: 1 });
    addNote({ pitch: 67, startPpq: 2, durationPpq: 1 });
    addNote({ pitch: 72, startPpq: 3, durationPpq: 1 });
  }

  it('proposes and applies a follow-the-melody reharmonization in one undoable edit', () => {
    addCMajorArpeggio();
    // Seed a chord that clashes with the melody, then start from a clean slate.
    setProjectChords([{ startPpq: 0, endPpq: 4, rootPc: 11, quality: 0 }]);
    clearHistory();

    const proposal = proposeReharmonizationForActiveClip({
      editedSpan: { startPpq: 0, endPpq: 4 },
    });
    expect(proposal).not.toBeNull();
    if (proposal === null) return;
    expect(proposal.changed).toBe(true);

    applyReharmonizationProposal(proposal);
    expect(store.chords).toHaveLength(1);
    expect(store.chords[0].rootPc).not.toBe(11);
    expect(store.chords[0]).toMatchObject({ startPpq: 0, endPpq: 4 });

    undo();
    expect(store.chords[0].rootPc).toBe(11);
  });

  it('does not touch the chord track when the proposal changes nothing', () => {
    addCMajorArpeggio();
    // A C-major chord already fits the C-major arpeggio, so the pass proposes
    // no change and applying it is a no-op.
    setProjectChords([{ startPpq: 0, endPpq: 4, rootPc: 0, quality: 0 }]);
    clearHistory();

    const proposal = proposeReharmonizationForActiveClip({
      editedSpan: { startPpq: 0, endPpq: 4 },
    });
    expect(proposal?.changed).toBe(false);
    if (proposal === null) return;

    applyReharmonizationProposal(proposal);
    expect(store.chords[0]).toMatchObject({ rootPc: 0 });
    // No history entry was created, so there is nothing to undo.
    expect(() => undo()).not.toThrow();
    expect(store.chords[0]).toMatchObject({ rootPc: 0 });
  });

  it('never reharmonizes a locked region', () => {
    addCMajorArpeggio();
    setProjectChords([{ startPpq: 0, endPpq: 4, rootPc: 11, quality: 0 }]);
    clearHistory();

    const proposal = proposeReharmonizationForActiveClip({
      editedSpan: { startPpq: 0, endPpq: 4 },
      locked: [{ startPpq: 0, endPpq: 4 }],
    });
    expect(proposal?.changed).toBe(false);
    expect(proposal?.proposal[0]).toMatchObject({ rootPc: 11 });
  });

  it('proposes nothing for a percussion clip', () => {
    setTrackPercussion(store.activeTrackId, true);
    addCMajorArpeggio();
    setProjectChords([{ startPpq: 0, endPpq: 4, rootPc: 11, quality: 0 }]);
    expect(
      proposeReharmonizationForActiveClip({ editedSpan: { startPpq: 0, endPpq: 4 } }),
    ).toBeNull();
  });

  it('leaves channel-10 notes on a melodic track out of the melody', () => {
    addCMajorArpeggio();
    setProjectChords([{ startPpq: 0, endPpq: 4, rootPc: 0, quality: 0 }]);
    // A held B above the arpeggio would clash with C major if it were read as melody.
    addNote({ pitch: 95, startPpq: 0, durationPpq: 4, channel: 9 });
    const proposal = proposeReharmonizationForActiveClip({
      editedSpan: { startPpq: 0, endPpq: 4 },
    });
    expect(proposal?.changed).toBe(false);
  });

  it('returns null when there is no active clip', () => {
    store.clipId = -1;
    const proposal = proposeReharmonizationForActiveClip({
      editedSpan: { startPpq: 0, endPpq: 4 },
    });
    expect(proposal).toBeNull();
  });

  it('rejects a proposal after its key, meter, clip or lock context changes', () => {
    addCMajorArpeggio();
    setProjectChords([{ startPpq: 0, endPpq: 4, rootPc: 11, quality: 0 }]);
    const makeProposal = () =>
      proposeReharmonizationForActiveClip({ editedSpan: { startPpq: 0, endPpq: 4 } });

    const keyProposal = makeProposal();
    expect(keyProposal?.changed).toBe(true);
    store.scaleHighlight = { ...store.scaleHighlight, rootPc: 2 };
    if (keyProposal) expect(applyReharmonizationProposal(keyProposal)).toBe(false);

    store.scaleHighlight = { ...store.scaleHighlight, rootPc: 0 };
    const meterProposal = makeProposal();
    store.timeSignatures = [{ startPpq: 0, numerator: 3, denominator: 4 }];
    if (meterProposal) expect(applyReharmonizationProposal(meterProposal)).toBe(false);

    store.timeSignatures = [{ startPpq: 0, numerator: 4, denominator: 4 }];
    const clipProposal = makeProposal();
    if (store.activeClip) store.activeClip.lengthPpq -= 1;
    if (clipProposal) expect(applyReharmonizationProposal(clipProposal)).toBe(false);

    if (store.activeClip) store.activeClip.lengthPpq += 1;
    const lockProposal = makeProposal();
    if (lockProposal) {
      expect(applyReharmonizationProposal(lockProposal, [{ startPpq: 0, endPpq: 4 }])).toBe(false);
    }
    expect(store.chords[0].rootPc).toBe(11);
  });
});

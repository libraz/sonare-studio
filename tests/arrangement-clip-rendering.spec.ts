import { describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { ARRANGEMENT_COLORS } from '@/components/arrangement/theme';
import { normalizeTempoMap } from '@/project/tempo-map';
import type { EditorClip, EditorTrack } from '@/project/types';
import type { ClipInteractions } from '@/ui/arrangement/use-clip-interactions';
import { type ClipRenderContext, drawClip } from '@/ui/arrangement/use-clip-rendering';
import { TimelineRange } from '@/ui/canvas/timeline-range';

function canvasContext(): CanvasRenderingContext2D {
  return {
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    rect: vi.fn(),
    clip: vi.fn(),
    fillRect: vi.fn(),
    strokeRect: vi.fn(),
    fillText: vi.fn(),
  } as unknown as CanvasRenderingContext2D;
}

function interactions(): ClipInteractions {
  return {
    previewClip: ref(null),
    previewClips: ref([]),
    previewFades: ref(null),
    previewDraft: ref(null),
    previewMarquee: ref(null),
  } as unknown as ClipInteractions;
}

function midiClip(notes: EditorClip['notes']): EditorClip {
  return {
    id: 1,
    trackId: 1,
    name: 'MIDI',
    startPpq: 0,
    lengthPpq: 40,
    sourceOffsetPpq: 0,
    gain: 1,
    loopEnabled: false,
    loopLengthPpq: 0,
    notes,
  };
}

describe('arrangement mini-note rendering', () => {
  it('draws only visible notes while keeping an off-screen sustain', () => {
    const ctx = canvasContext();
    const range = new TimelineRange({
      widthPx: 100,
      heightPx: 100,
      pxPerPpq: 10,
      startPpq: 10,
    });
    const track = {
      id: 1,
      name: 'Track',
      color: '#4fa8e8',
      kind: 'midi',
      mute: false,
      solo: false,
      volume: 1,
      pan: 0,
      order: 0,
    } as EditorTrack;
    const source = midiClip([
      { id: 1, startPpq: 0, durationPpq: 40, pitch: 40, velocity: 100, channel: 0 },
      { id: 2, startPpq: 5, durationPpq: 1, pitch: 50, velocity: 100, channel: 0 },
      { id: 3, startPpq: 15, durationPpq: 1, pitch: 60, velocity: 100, channel: 0 },
      { id: 4, startPpq: 20, durationPpq: 1, pitch: 70, velocity: 100, channel: 0 },
    ]);
    const context: ClipRenderContext = {
      range,
      tracks: [track],
      trackIndexById: new Map([[1, 0]]),
      laneHeight: 56,
      laneTop: () => 0,
      barPpq: 4,
      tempoMap: normalizeTempoMap([]),
      interactions: interactions(),
      scheduleBase: vi.fn(),
      colors: ARRANGEMENT_COLORS,
    };

    drawClip(ctx, source, source, false, context);

    const fillRect = ctx.fillRect as unknown as ReturnType<typeof vi.fn>;
    // One clip body plus the sustained note and the note at PPQ 15. The
    // note at 5 is before the viewport and PPQ 20 only touches its right edge.
    expect(fillRect).toHaveBeenCalledTimes(3);
    expect(fillRect.mock.calls[1][0]).toBe(-100);
    expect(fillRect.mock.calls[2][0]).toBeCloseTo(49.625);
  });
});

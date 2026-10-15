import { describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { ARRANGEMENT_COLORS } from '@/components/arrangement/theme';
import { normalizeTempoMap } from '@/project/tempo-map';
import type { EditorClip, EditorTrack } from '@/project/types';
import type { ClipInteractions } from '@/ui/arrangement/use-clip-interactions';
import { type ClipRenderContext, drawClip } from '@/ui/arrangement/use-clip-rendering';
import { TimelineRange } from '@/ui/canvas/timeline-range';

const colorCalls = vi.hoisted(() => ({ count: 0 }));
vi.mock('@/components/arrangement/theme', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/arrangement/theme')>();
  return {
    ...actual,
    colorWithAlpha: (color: string, alpha: number) => {
      colorCalls.count++;
      return actual.colorWithAlpha(color, alpha);
    },
  };
});

const BARS = 1000;

function setup() {
  const ctx = {
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    rect: vi.fn(),
    clip: vi.fn(),
    fillRect: vi.fn(),
    strokeRect: vi.fn(),
    fillText: vi.fn(),
  } as unknown as CanvasRenderingContext2D;
  const track = { id: 1, name: 'T', color: '#4fa8e8' } as EditorTrack;
  const notes = Array.from({ length: BARS }, (_, i) => ({
    id: i + 1,
    startPpq: i * 4,
    durationPpq: 1 + (i % 3),
    pitch: 60,
    velocity: 100,
    channel: 0,
  }));
  const source = {
    id: 1,
    trackId: 1,
    name: 'MIDI',
    startPpq: 0,
    lengthPpq: BARS * 4,
    sourceOffsetPpq: 0,
    gain: 1,
    loopEnabled: false,
    loopLengthPpq: 0,
    notes,
  } as unknown as EditorClip;
  const context: ClipRenderContext = {
    // 1 px per ppq: density mode, 400 px shows 100 bars.
    range: new TimelineRange({ widthPx: 400, heightPx: 100, pxPerPpq: 1, startPpq: 400 }),
    tracks: [track],
    trackIndexById: new Map([[1, 0]]),
    laneHeight: 56,
    laneTop: () => 0,
    barPpq: 4,
    tempoMap: normalizeTempoMap([]),
    interactions: {
      previewClip: ref(null),
      previewClips: ref([]),
      previewFades: ref(null),
      previewDraft: ref(null),
      previewMarquee: ref(null),
    } as unknown as ClipInteractions,
    scheduleBase: vi.fn(),
    colors: ARRANGEMENT_COLORS,
  };
  return { ctx, source, context };
}

describe('density block rendering', () => {
  it('draws only the buckets inside the viewport', () => {
    const { ctx, source, context } = setup();
    drawClip(ctx, source, source, false, context);
    const fillRect = ctx.fillRect as unknown as ReturnType<typeof vi.fn>;
    // Clip body plus at most the ~100 visible bars (+ edge buckets).
    expect(fillRect.mock.calls.length).toBeLessThanOrEqual(1 + 102);
    expect(fillRect.mock.calls.length).toBeGreaterThan(50);
  });

  it('reuses bucket color strings across repeated paints', () => {
    const { ctx, source, context } = setup();
    drawClip(ctx, source, source, false, context);
    colorCalls.count = 0;
    drawClip(ctx, source, source, false, context);
    // Only the clip body fill resolves a color on a repeated paint.
    expect(colorCalls.count).toBeLessThanOrEqual(1);
  });
});

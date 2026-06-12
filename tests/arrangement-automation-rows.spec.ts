import { describe, expect, it } from 'vitest';
import {
  AUTOMATION_LANE_HEIGHT_PX,
  AUTOMATION_LANE_PAD_PX,
  automationValueDomain,
  automationValueToY,
  automationYToValue,
  buildRowLayout,
  TAKE_LANE_HEIGHT_PX,
  trackTakeRowCount,
} from '@/ui/arrangement/automation-rows';

describe('arrangement automation rows', () => {
  describe('buildRowLayout', () => {
    it('matches uniform lane math when nothing is expanded', () => {
      const layout = buildRowLayout([false, false, false], 40);
      expect(layout.rowTop(0)).toBe(0);
      expect(layout.rowTop(1)).toBe(40);
      expect(layout.rowTop(2)).toBe(80);
      expect(layout.rowTop(3)).toBe(120);
      expect(layout.rowHeight(0)).toBe(40);
      expect(layout.totalHeight).toBe(120);
    });

    it('adds the sublane height to expanded rows and shifts later rows down', () => {
      const layout = buildRowLayout([false, true, false], 40, 56);
      expect(layout.rowTop(0)).toBe(0);
      expect(layout.rowTop(1)).toBe(40);
      expect(layout.rowTop(2)).toBe(136);
      expect(layout.rowHeight(0)).toBe(40);
      expect(layout.rowHeight(1)).toBe(96);
      expect(layout.rowHeight(2)).toBe(40);
      expect(layout.totalHeight).toBe(176);
    });

    it('defaults the sublane height to AUTOMATION_LANE_HEIGHT_PX', () => {
      const layout = buildRowLayout([true], 40);
      expect(layout.totalHeight).toBe(40 + AUTOMATION_LANE_HEIGHT_PX);
    });

    it('clamps rowTop indices into the row range', () => {
      const layout = buildRowLayout([true, false], 40, 56);
      expect(layout.rowTop(-1)).toBe(0);
      expect(layout.rowTop(99)).toBe(layout.totalHeight);
    });

    it('hit-tests track and automation zones with exact boundaries', () => {
      const layout = buildRowLayout([true, false], 40, 56);
      expect(layout.hitTest(0)).toEqual({ index: 0, zone: 'track' });
      expect(layout.hitTest(39)).toEqual({ index: 0, zone: 'track' });
      expect(layout.hitTest(40)).toEqual({ index: 0, zone: 'automation' });
      expect(layout.hitTest(95)).toEqual({ index: 0, zone: 'automation' });
      expect(layout.hitTest(96)).toEqual({ index: 1, zone: 'track' });
      expect(layout.hitTest(135)).toEqual({ index: 1, zone: 'track' });
    });

    it('returns null outside the rows', () => {
      const layout = buildRowLayout([false, true], 40, 56);
      expect(layout.hitTest(-1)).toBeNull();
      expect(layout.hitTest(layout.totalHeight)).toBeNull();
      expect(layout.hitTest(layout.totalHeight + 100)).toBeNull();
    });

    it('handles an empty track list', () => {
      const layout = buildRowLayout([], 40);
      expect(layout.totalHeight).toBe(0);
      expect(layout.rowTop(0)).toBe(0);
      expect(layout.hitTest(0)).toBeNull();
    });

    it('stacks take sub-rows between the lane and the automation sublane', () => {
      const layout = buildRowLayout([false, true], 40, 56, [2, 1], 40);
      expect(layout.rowTop(0)).toBe(0);
      expect(layout.rowTop(1)).toBe(120);
      expect(layout.rowHeight(0)).toBe(120);
      expect(layout.rowHeight(1)).toBe(136);
      expect(layout.totalHeight).toBe(256);
      expect(layout.takeTop(0, 0)).toBe(40);
      expect(layout.takeTop(0, 1)).toBe(80);
      expect(layout.takeTop(1, 0)).toBe(160);
      expect(layout.automationTop(1)).toBe(200);
      // Without take rows the automation top is the lane bottom.
      expect(buildRowLayout([true], 40, 56).automationTop(0)).toBe(40);
    });

    it('hit-tests take sub-rows with their take index', () => {
      const layout = buildRowLayout([false, true], 40, 56, [2, 1], 40);
      expect(layout.hitTest(39)).toEqual({ index: 0, zone: 'track' });
      expect(layout.hitTest(40)).toEqual({ index: 0, zone: 'take', takeIndex: 0 });
      expect(layout.hitTest(79)).toEqual({ index: 0, zone: 'take', takeIndex: 0 });
      expect(layout.hitTest(80)).toEqual({ index: 0, zone: 'take', takeIndex: 1 });
      expect(layout.hitTest(119)).toEqual({ index: 0, zone: 'take', takeIndex: 1 });
      expect(layout.hitTest(120)).toEqual({ index: 1, zone: 'track' });
      expect(layout.hitTest(160)).toEqual({ index: 1, zone: 'take', takeIndex: 0 });
      expect(layout.hitTest(200)).toEqual({ index: 1, zone: 'automation' });
      expect(layout.hitTest(255)).toEqual({ index: 1, zone: 'automation' });
      expect(layout.hitTest(256)).toBeNull();
    });

    it('defaults the take sub-row height to TAKE_LANE_HEIGHT_PX', () => {
      const layout = buildRowLayout([false], 40, 56, [3]);
      expect(layout.totalHeight).toBe(40 + 3 * TAKE_LANE_HEIGHT_PX);
    });
  });

  describe('trackTakeRowCount', () => {
    it('returns the maximum take count among the track clips', () => {
      const clips = [
        { trackId: 1, takes: [{}, {}] },
        { trackId: 1, takes: [{}, {}, {}] },
        { trackId: 1 },
        { trackId: 2, takes: [{}] },
      ];
      expect(trackTakeRowCount(clips, 1)).toBe(3);
      expect(trackTakeRowCount(clips, 2)).toBe(1);
      expect(trackTakeRowCount(clips, 3)).toBe(0);
    });
  });

  describe('automationValueDomain', () => {
    it('uses the display dB window for fader lanes and full range for pan', () => {
      expect(automationValueDomain('faderDb')).toEqual({ min: -60, max: 12 });
      expect(automationValueDomain('pan')).toEqual({ min: -1, max: 1 });
    });
  });

  describe('automationValueToY / automationYToValue', () => {
    const top = 100;
    const height = 56;
    const innerTop = top + AUTOMATION_LANE_PAD_PX;
    const innerBottom = top + height - AUTOMATION_LANE_PAD_PX;

    it('maps the domain max to the padded top and the min to the padded bottom', () => {
      expect(automationValueToY('pan', 1, top, height)).toBe(innerTop);
      expect(automationValueToY('pan', -1, top, height)).toBe(innerBottom);
      expect(automationValueToY('pan', 0, top, height)).toBe((innerTop + innerBottom) / 2);
    });

    it('clamps values outside the display domain to the padded edges', () => {
      expect(automationValueToY('faderDb', 24, top, height)).toBe(innerTop);
      expect(automationValueToY('faderDb', -120, top, height)).toBe(innerBottom);
    });

    it('round-trips values through y and back', () => {
      for (const value of [-1, -0.5, 0, 0.25, 1]) {
        const y = automationValueToY('pan', value, top, height);
        expect(automationYToValue('pan', y, top, height)).toBeCloseTo(value, 12);
      }
      for (const value of [-60, -30, 0, 12]) {
        const y = automationValueToY('faderDb', value, top, height);
        expect(automationYToValue('faderDb', y, top, height)).toBeCloseTo(value, 12);
      }
    });

    it('clamps y positions outside the padded band to the domain edges', () => {
      expect(automationYToValue('pan', top - 50, top, height)).toBe(1);
      expect(automationYToValue('pan', top + height + 50, top, height)).toBe(-1);
    });
  });
});

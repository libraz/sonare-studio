import { describe, expect, it } from 'vitest';
import {
  dbToFaderPosition,
  FADER_MAX_DB,
  FADER_MIN_DB,
  faderPositionToDb,
  formatDb,
  formatHz,
  formatPan,
} from '@/ui/mixer/db-scale';

describe('faderPositionToDb / dbToFaderPosition', () => {
  it('maps the throw extremes to the fader range', () => {
    expect(FADER_MAX_DB).toBe(24);
    expect(faderPositionToDb(0)).toBe(FADER_MIN_DB);
    expect(faderPositionToDb(1)).toBe(FADER_MAX_DB);
    expect(dbToFaderPosition(FADER_MIN_DB)).toBe(0);
    expect(dbToFaderPosition(FADER_MAX_DB)).toBe(1);
  });

  it('places unity gain at 3/4 of the throw', () => {
    expect(faderPositionToDb(0.75)).toBeCloseTo(0, 10);
    expect(dbToFaderPosition(0)).toBeCloseTo(0.75, 10);
  });

  it('is monotonically increasing', () => {
    let previous = faderPositionToDb(0);
    for (let i = 1; i <= 100; i++) {
      const db = faderPositionToDb(i / 100);
      expect(db).toBeGreaterThan(previous);
      previous = db;
    }
  });

  it('round-trips dB values through positions', () => {
    for (const db of [-96, -72, -48, -24, -12, -6, -3, 0, 3, 6, 12, 18, 24]) {
      expect(faderPositionToDb(dbToFaderPosition(db))).toBeCloseTo(db, 9);
    }
  });

  it('round-trips positions through dB values', () => {
    for (const position of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
      expect(dbToFaderPosition(faderPositionToDb(position))).toBeCloseTo(position, 9);
    }
  });

  it('clamps out-of-range inputs', () => {
    expect(faderPositionToDb(-0.5)).toBe(FADER_MIN_DB);
    expect(faderPositionToDb(2)).toBe(FADER_MAX_DB);
    expect(dbToFaderPosition(-200)).toBe(0);
    expect(dbToFaderPosition(100)).toBe(1);
  });
});

describe('formatDb', () => {
  it('formats with an explicit sign and one decimal', () => {
    expect(formatDb(0)).toBe('0.0');
    expect(formatDb(3.25)).toBe('+3.3');
    expect(formatDb(-12)).toBe('-12.0');
  });

  it('avoids a negative zero', () => {
    expect(formatDb(-0.01)).toBe('0.0');
  });

  it('renders the silence floor as -inf', () => {
    expect(formatDb(-96)).toBe('-inf');
    expect(formatDb(-90)).toBe('-inf');
    expect(formatDb(-89.9)).toBe('-89.9');
  });

  it('honors fraction digits', () => {
    expect(formatDb(1.234, 2)).toBe('+1.23');
  });
});

describe('formatPan', () => {
  it('renders center, left and right', () => {
    expect(formatPan(0)).toBe('C');
    expect(formatPan(-0.5)).toBe('L50');
    expect(formatPan(0.5)).toBe('R50');
    expect(formatPan(-1)).toBe('L100');
    expect(formatPan(1)).toBe('R100');
  });

  it('clamps and rounds', () => {
    expect(formatPan(2)).toBe('R100');
    expect(formatPan(0.004)).toBe('C');
  });
});

describe('formatHz', () => {
  it('formats sub-kilohertz as integers', () => {
    expect(formatHz(250)).toBe('250');
    expect(formatHz(999.4)).toBe('999');
  });

  it('formats kilohertz compactly', () => {
    expect(formatHz(1000)).toBe('1.0k');
    expect(formatHz(1250)).toBe('1.3k');
    expect(formatHz(12000)).toBe('12k');
  });
});

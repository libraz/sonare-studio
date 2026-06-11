import { describe, expect, it } from 'vitest';
import { TourSequence, type TourStep } from '@/components/onboarding/tour-steps';

const step = (id: string): TourStep => ({
  id,
  target: `#${id}`,
  title: id,
  body: `About ${id}`,
});

const STEPS = [step('a'), step('b'), step('c'), step('d')];

const allAvailable = () => true;

/** Availability predicate that knows the given targets only. */
const available =
  (...targets: string[]) =>
  (target: string) =>
    targets.includes(target);

describe('TourSequence', () => {
  it('starts idle and ignores navigation before start', () => {
    const tour = new TourSequence(STEPS, allAvailable);
    expect(tour.status).toBe('idle');
    expect(tour.current).toBeNull();
    tour.next();
    tour.back();
    tour.skip();
    expect(tour.status).toBe('idle');
    expect(tour.outcome).toBeNull();
  });

  it('walks forward through all steps and completes past the last one', () => {
    const tour = new TourSequence(STEPS, allAvailable);
    expect(tour.start()).toBe(true);
    const seen: string[] = [];
    while (tour.current !== null) {
      seen.push(tour.current.id);
      tour.next();
    }
    expect(seen).toEqual(['a', 'b', 'c', 'd']);
    expect(tour.status).toBe('done');
    expect(tour.outcome).toBe('completed');
  });

  it('moves back across steps and stays put on the first one', () => {
    const tour = new TourSequence(STEPS, allAvailable);
    tour.start();
    tour.next();
    tour.next();
    expect(tour.current?.id).toBe('c');
    tour.back();
    expect(tour.current?.id).toBe('b');
    tour.back();
    expect(tour.current?.id).toBe('a');
    expect(tour.hasBack).toBe(false);
    tour.back();
    expect(tour.current?.id).toBe('a');
    expect(tour.status).toBe('active');
  });

  it('skips unavailable steps in both directions', () => {
    const tour = new TourSequence(STEPS, available('#a', '#c'));
    tour.start();
    expect(tour.current?.id).toBe('a');
    tour.next();
    expect(tour.current?.id).toBe('c');
    tour.back();
    expect(tour.current?.id).toBe('a');
  });

  it('starts at the first available step when earlier ones are missing', () => {
    const tour = new TourSequence(STEPS, available('#b', '#d'));
    expect(tour.start()).toBe(true);
    expect(tour.current?.id).toBe('b');
  });

  it('refuses to start when no step is available', () => {
    const tour = new TourSequence(STEPS, available());
    expect(tour.start()).toBe(false);
    expect(tour.status).toBe('idle');
    expect(tour.current).toBeNull();
  });

  it('completes when the remaining steps are all unavailable', () => {
    const tour = new TourSequence(STEPS, available('#a', '#b'));
    tour.start();
    tour.next();
    expect(tour.current?.id).toBe('b');
    tour.next();
    expect(tour.status).toBe('done');
    expect(tour.outcome).toBe('completed');
  });

  it('marks an early exit as skipped', () => {
    const tour = new TourSequence(STEPS, allAvailable);
    tour.start();
    tour.next();
    tour.skip();
    expect(tour.status).toBe('done');
    expect(tour.outcome).toBe('skipped');
    expect(tour.current).toBeNull();
  });

  it('reports progress over the available steps', () => {
    const tour = new TourSequence(STEPS, available('#a', '#c', '#d'));
    tour.start();
    expect(tour.progress).toEqual({ index: 1, count: 3 });
    tour.next();
    expect(tour.progress).toEqual({ index: 2, count: 3 });
    tour.next();
    expect(tour.progress).toEqual({ index: 3, count: 3 });
  });

  it('keeps counting the current step if its target vanishes mid-step', () => {
    let targets = ['#a', '#b', '#c', '#d'];
    const tour = new TourSequence(STEPS, (target) => targets.includes(target));
    tour.start();
    tour.next();
    expect(tour.current?.id).toBe('b');
    targets = ['#a', '#c', '#d'];
    expect(tour.current?.id).toBe('b');
    expect(tour.progress).toEqual({ index: 2, count: 4 });
    tour.next();
    expect(tour.current?.id).toBe('c');
  });

  it('reflects availability changes between moves', () => {
    let targets = ['#a'];
    const tour = new TourSequence(STEPS, (target) => targets.includes(target));
    tour.start();
    expect(tour.hasNext).toBe(false);
    targets = ['#a', '#d'];
    expect(tour.hasNext).toBe(true);
    tour.next();
    expect(tour.current?.id).toBe('d');
  });

  it('restarts cleanly after completion', () => {
    const tour = new TourSequence(STEPS, allAvailable);
    tour.start();
    tour.skip();
    expect(tour.start()).toBe(true);
    expect(tour.status).toBe('active');
    expect(tour.outcome).toBeNull();
    expect(tour.current?.id).toBe('a');
  });
});

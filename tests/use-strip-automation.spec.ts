import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it } from 'vitest';
import { computed } from 'vue';
import { linearToDb } from '@/lib/db';
import { createDefaultStrip } from '@/project/mixer';
import { useProjectStore } from '@/project/store';
import type { EditorTrack } from '@/project/types';
import { resetAutomationStripModes, setAutomationStripMode } from '@/ui/mixer/automation-mode';
import { useStripAutomation } from '@/ui/mixer/use-strip-automation';
import { useStripGestures } from '@/ui/mixer/use-strip-gestures';

/** Builds a minimal track mirror entry for strip automation tests. */
function track(overrides: Partial<EditorTrack> = {}): EditorTrack {
  return {
    id: 1,
    name: 'Track 1',
    color: '#60a5fa',
    kind: 'midi',
    mute: false,
    solo: false,
    volume: 1,
    pan: 0,
    order: 0,
    mixer: createDefaultStrip(),
    ...overrides,
  };
}

describe('useStripAutomation', () => {
  let store: ReturnType<typeof useProjectStore>;

  beforeEach(() => {
    setActivePinia(createPinia());
    resetAutomationStripModes();
    store = useProjectStore();
    store.tracks = [track({ vcaId: 'vca-1' })];
    store.mixer = {
      master: createDefaultStrip(),
      buses: [],
      vcaGroups: [{ id: 'vca-1', name: 'Drums', gainDb: -6 }],
    };
    store.automationLanes = [];
  });

  function automation(positionPpq = () => 0) {
    return useStripAutomation({
      target: () => 1,
      isMaster: computed(() => false),
      track: computed(() => store.tracks[0]),
      strip: computed(() => store.tracks[0].mixer ?? createDefaultStrip()),
      positionPpq,
      isPlaying: () => false,
    });
  }

  it('keeps fader automation in the pre-VCA strip domain', () => {
    store.automationLanes = [
      {
        target: 1,
        param: 'faderDb',
        enabled: true,
        points: [{ ppq: 0, value: -9 }],
      },
    ];
    setAutomationStripMode(1, 'read');

    const stripAutomation = automation();

    expect(stripAutomation.laneOffsetDb.value).toBe(0);
    expect(stripAutomation.displayedGainDb.value).toBe(-9);

    store.mixer = {
      ...store.mixer,
      vcaGroups: [{ id: 'vca-1', name: 'Drums', gainDb: -12 }],
    };

    expect(stripAutomation.laneOffsetDb.value).toBe(0);
    expect(stripAutomation.displayedGainDb.value).toBe(-9);
  });

  it('shows the combined static track volume and strip gain', () => {
    store.tracks[0] = track({ volume: 0.5, mixer: { ...createDefaultStrip(), gainDb: -3 } });

    expect(automation().displayedGainDb.value).toBeCloseTo(-3 - 6.020599913, 8);
  });

  it('writes the strip trim corresponding to the displayed static fader value', () => {
    store.tracks[0] = track({ volume: 0.5, mixer: { ...createDefaultStrip(), gainDb: -3 } });
    const gestures = useStripGestures({
      target: () => 1,
      strip: computed(() => store.tracks[0].mixer ?? createDefaultStrip()),
      automation: automation(),
    });

    gestures.onGainChange(-9, true);

    const stripGainDb = store.tracks[0].mixer?.gainDb;
    expect(stripGainDb).toBeCloseTo(-9 - linearToDb(0.5), 8);
    expect(linearToDb(store.tracks[0].volume) + (stripGainDb ?? 0)).toBeCloseTo(-9, 8);
  });

  it('records touch fader automation in the pre-VCA strip domain', () => {
    setAutomationStripMode(1, 'touch');
    const stripAutomation = automation();
    const gestures = useStripGestures({
      target: () => 1,
      strip: computed(() => store.tracks[0].mixer ?? createDefaultStrip()),
      automation: stripAutomation,
    });

    gestures.onGainChange(-3, true);

    expect(store.automationLanes).toEqual([
      {
        target: 1,
        param: 'faderDb',
        enabled: true,
        points: [{ ppq: 0, value: -3 }],
      },
    ]);
  });

  it('forwards write-mode fader drags to the schedule hook with lane-domain values', () => {
    setAutomationStripMode(1, 'touch');
    let ppq = 4;
    let sample = 192000;
    const scheduled: unknown[] = [];
    const stripAutomation = useStripAutomation({
      target: () => 1,
      isMaster: computed(() => false),
      track: computed(() => store.tracks[0]),
      strip: computed(() => store.tracks[0].mixer ?? createDefaultStrip()),
      positionPpq: () => ppq,
      positionSample: () => sample,
      isPlaying: () => true,
      scheduleAutomationWrite: (...args) => scheduled.push(args),
    });
    const gestures = useStripGestures({
      target: () => 1,
      strip: computed(() => store.tracks[0].mixer ?? createDefaultStrip()),
      automation: stripAutomation,
    });

    gestures.onGainChange(-3, false);
    ppq = 4.25;
    sample = 204000;
    gestures.onGainChange(-2, true);

    expect(scheduled).toEqual([
      [1, 'faderDb', { ppq: 4, samplePos: 192000, value: -3 }],
      [1, 'faderDb', { ppq: 4.25, samplePos: 204000, value: -2 }],
    ]);
  });
});

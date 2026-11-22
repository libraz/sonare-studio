import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { LAYOUTS_STORAGE_KEY, useLayouts } from '@/composables/useLayouts';
import {
  applyLayoutState,
  captureLayoutState,
  type DockTabId,
  decodeUserLayouts,
  encodeUserLayouts,
  LAYOUT_PRESETS,
  type LayoutBindings,
  sanitizeLayoutState,
} from '@/ui/settings/layouts';

function makeBindings(): LayoutBindings {
  return {
    arrangeHeightPx: ref(260),
    dockTab: ref<DockTabId>('roll'),
    deviceRackOpen: ref(true),
    scoreOpen: ref(false),
    dockCollapsed: ref(false),
  };
}

describe('sanitizeLayoutState', () => {
  it('returns null for non-objects', () => {
    expect(sanitizeLayoutState(null)).toBeNull();
    expect(sanitizeLayoutState('x')).toBeNull();
  });

  it('clamps the height and defaults invalid fields', () => {
    const out = sanitizeLayoutState({ arrangeHeightPx: 5, dockTab: 'nope', scoreOpen: true });
    expect(out).toEqual({
      arrangeHeightPx: 120,
      dockTab: 'roll',
      deviceRackOpen: true,
      scoreOpen: true,
      dockCollapsed: false,
    });
  });

  it('keeps a fully valid state', () => {
    const state = {
      arrangeHeightPx: 300,
      dockTab: 'mixer',
      deviceRackOpen: false,
      scoreOpen: true,
      dockCollapsed: true,
    };
    expect(sanitizeLayoutState(state)).toEqual(state);
  });
});

describe('captureLayoutState / applyLayoutState', () => {
  it('captures the current ref values', () => {
    const bindings = makeBindings();
    bindings.dockTab.value = 'mastering';
    bindings.arrangeHeightPx.value = 333;
    expect(captureLayoutState(bindings)).toEqual({
      arrangeHeightPx: 333,
      dockTab: 'mastering',
      deviceRackOpen: true,
      scoreOpen: false,
      dockCollapsed: false,
    });
  });

  it('applies a state into the refs, clamping first', () => {
    const bindings = makeBindings();
    applyLayoutState(
      {
        arrangeHeightPx: 99999,
        dockTab: 'mixer',
        deviceRackOpen: false,
        scoreOpen: true,
        dockCollapsed: true,
      },
      bindings,
    );
    expect(bindings.arrangeHeightPx.value).toBe(2000);
    expect(bindings.dockTab.value).toBe('mixer');
    expect(bindings.deviceRackOpen.value).toBe(false);
    expect(bindings.scoreOpen.value).toBe(true);
    expect(bindings.dockCollapsed.value).toBe(true);
  });
});

describe('layout storage codec', () => {
  it('round-trips named layouts', () => {
    const layouts = [
      {
        name: 'My mix',
        state: {
          arrangeHeightPx: 200,
          dockTab: 'mixer' as DockTabId,
          deviceRackOpen: false,
          scoreOpen: false,
          dockCollapsed: false,
        },
      },
    ];
    expect(decodeUserLayouts(encodeUserLayouts(layouts))).toEqual(layouts);
  });

  it('drops malformed entries, duplicates and corrupt payloads', () => {
    expect(decodeUserLayouts(null)).toEqual([]);
    expect(decodeUserLayouts('{oops')).toEqual([]);
    expect(decodeUserLayouts(JSON.stringify({ version: 1, layouts: 'x' }))).toEqual([]);
    const decoded = decodeUserLayouts(
      JSON.stringify({
        version: 1,
        layouts: [
          { name: '', state: {} },
          { name: 'ok', state: {} },
          { name: 'ok', state: {} },
          { name: 'broken', state: 7 },
          'junk',
        ],
      }),
    );
    expect(decoded.map((layout) => layout.name)).toEqual(['ok']);
  });
});

describe('useLayouts', () => {
  beforeEach(() => {
    window.localStorage.clear();
    useLayouts().reload();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lists the built-in presets first', () => {
    const layouts = useLayouts();
    expect(layouts.presets.map((preset) => preset.name)).toEqual([
      'Compose',
      'Mix',
      'Score',
      'Arrange',
    ]);
    expect(layouts.layouts.value.slice(0, 4)).toEqual([...LAYOUT_PRESETS]);
    expect(layouts.isPreset('Mix')).toBe(true);
    expect(layouts.isPreset('Mine')).toBe(false);
  });

  it('applies a preset to the bindings', () => {
    const layouts = useLayouts();
    const bindings = makeBindings();
    expect(layouts.apply('Mix', bindings)).toBe(true);
    expect(bindings.dockTab.value).toBe('mixer');
    expect(bindings.deviceRackOpen.value).toBe(false);
    expect(layouts.apply('Nope', bindings)).toBe(false);
  });

  it('saves the current layout and persists it', () => {
    const layouts = useLayouts();
    const bindings = makeBindings();
    bindings.arrangeHeightPx.value = 321;
    bindings.dockTab.value = 'steps';
    expect(layouts.saveCurrent('  Beat making ', bindings)).toBe(true);
    expect(layouts.userLayouts.value).toEqual([
      {
        name: 'Beat making',
        state: {
          arrangeHeightPx: 321,
          dockTab: 'steps',
          deviceRackOpen: true,
          scoreOpen: false,
          dockCollapsed: false,
        },
      },
    ]);
    expect(decodeUserLayouts(window.localStorage.getItem(LAYOUTS_STORAGE_KEY))).toEqual(
      layouts.userLayouts.value,
    );
  });

  it('overwrites an existing user layout with the same name', () => {
    const layouts = useLayouts();
    const bindings = makeBindings();
    layouts.saveCurrent('Mine', bindings);
    bindings.scoreOpen.value = true;
    layouts.saveCurrent('Mine', bindings);
    expect(layouts.userLayouts.value).toHaveLength(1);
    expect(layouts.userLayouts.value[0].state.scoreOpen).toBe(true);
  });

  it('rejects empty and preset-shadowing names', () => {
    const layouts = useLayouts();
    const bindings = makeBindings();
    expect(layouts.saveCurrent('', bindings)).toBe(false);
    expect(layouts.saveCurrent('   ', bindings)).toBe(false);
    expect(layouts.saveCurrent('Compose', bindings)).toBe(false);
    expect(layouts.userLayouts.value).toEqual([]);
  });

  it('applies a saved layout back', () => {
    const layouts = useLayouts();
    const source = makeBindings();
    source.dockTab.value = 'media';
    source.scoreOpen.value = true;
    layouts.saveCurrent('Browse', source);
    const target = makeBindings();
    expect(layouts.apply('Browse', target)).toBe(true);
    expect(target.dockTab.value).toBe('media');
    expect(target.scoreOpen.value).toBe(true);
  });

  it('removes only user layouts', () => {
    const layouts = useLayouts();
    layouts.saveCurrent('Gone soon', makeBindings());
    expect(layouts.remove('Compose')).toBe(false);
    expect(layouts.remove('Gone soon')).toBe(true);
    expect(layouts.remove('Gone soon')).toBe(false);
    expect(layouts.userLayouts.value).toEqual([]);
  });

  it('renames a user layout with validation', () => {
    const layouts = useLayouts();
    const bindings = makeBindings();
    layouts.saveCurrent('First', bindings);
    layouts.saveCurrent('Second', bindings);
    expect(layouts.rename('First', 'Renamed')).toBe(true);
    expect(layouts.userLayouts.value.map((layout) => layout.name)).toEqual(['Renamed', 'Second']);
    expect(layouts.rename('Renamed', 'Second')).toBe(false);
    expect(layouts.rename('Renamed', 'Mix')).toBe(false);
    expect(layouts.rename('Renamed', '')).toBe(false);
    expect(layouts.rename('Missing', 'X')).toBe(false);
    expect(decodeUserLayouts(window.localStorage.getItem(LAYOUTS_STORAGE_KEY))?.[0].name).toBe(
      'Renamed',
    );
  });

  it('reloads from storage', () => {
    const layouts = useLayouts();
    window.localStorage.setItem(
      LAYOUTS_STORAGE_KEY,
      encodeUserLayouts([
        {
          name: 'External',
          state: {
            arrangeHeightPx: 150,
            dockTab: 'lists',
            dockCollapsed: false,
            deviceRackOpen: true,
            scoreOpen: false,
          },
        },
      ]),
    );
    layouts.reload();
    expect(layouts.userLayouts.value.map((layout) => layout.name)).toEqual(['External']);
  });

  it('yields no layouts for a corrupt payload', () => {
    const layouts = useLayouts();
    window.localStorage.setItem(LAYOUTS_STORAGE_KEY, '{not json');
    layouts.reload();
    expect(layouts.userLayouts.value).toEqual([]);
  });

  it('reloads empty and still saves in memory when storage throws', () => {
    const layouts = useLayouts();
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    expect(() => layouts.reload()).not.toThrow();
    expect(layouts.userLayouts.value).toEqual([]);
    expect(layouts.saveCurrent('Mine', makeBindings())).toBe(true);
    expect(layouts.userLayouts.value.map((layout) => layout.name)).toEqual(['Mine']);
  });
});

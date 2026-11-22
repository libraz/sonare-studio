import { afterEach, describe, expect, it, vi } from 'vitest';

const { getWasmModuleMock } = vi.hoisted(() => ({ getWasmModuleMock: vi.fn() }));
vi.mock('@/project/store', () => ({ getWasmModule: getWasmModuleMock }));

import {
  loadMixerScenePreset,
  loadMixerScenePresetCatalog,
  loadMixerScenePresetJson,
} from '@/ui/mixer/scene-presets';

const DOCUMENT = { version: 1, strips: [], buses: [], vcaGroups: [], connections: [] };

function fakeCore() {
  return {
    mixingScenePresetNames: () => ['vocalReverbSend', 'drumBusSubgroup'],
    mixingScenePreset: vi.fn(() => DOCUMENT),
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('mixer scene presets', () => {
  it('lists the core preset names', () => {
    getWasmModuleMock.mockReturnValue(fakeCore());
    expect(loadMixerScenePresetCatalog()).toEqual(['vocalReverbSend', 'drumBusSubgroup']);
  });

  it('returns the core scene document for a known preset', () => {
    const core = fakeCore();
    getWasmModuleMock.mockReturnValue(core);
    expect(loadMixerScenePreset('drumBusSubgroup')).toBe(DOCUMENT);
    expect(core.mixingScenePreset).toHaveBeenCalledWith('drumBusSubgroup');
  });

  it('serializes the document for the JSON scene import', () => {
    getWasmModuleMock.mockReturnValue(fakeCore());
    expect(JSON.parse(loadMixerScenePresetJson('vocalReverbSend'))).toEqual(DOCUMENT);
  });

  it('rejects a preset the core does not name', () => {
    const core = fakeCore();
    getWasmModuleMock.mockReturnValue(core);
    expect(() => loadMixerScenePreset('nope')).toThrow(RangeError);
    expect(core.mixingScenePreset).not.toHaveBeenCalled();
  });
});

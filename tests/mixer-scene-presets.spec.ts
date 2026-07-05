import { describe, expect, it } from 'vitest';
import { FALLBACK_INSERT_CATALOG } from '@/ui/mixer/insert-catalog';
import { FALLBACK_MIXER_SCENE_PRESETS, loadMixerScenePresetJson } from '@/ui/mixer/scene-presets';

function sceneProcessors(sceneJson: string): string[] {
  const scene = JSON.parse(sceneJson) as {
    buses?: Array<{ inserts?: Array<{ processor?: unknown }> }>;
    strips?: Array<{ inserts?: Array<{ processor?: unknown }> }>;
  };
  const processors: string[] = [];
  for (const bus of scene.buses ?? []) {
    for (const insert of bus.inserts ?? []) {
      if (typeof insert.processor === 'string') processors.push(insert.processor);
    }
  }
  for (const strip of scene.strips ?? []) {
    for (const insert of strip.inserts ?? []) {
      if (typeof insert.processor === 'string') processors.push(insert.processor);
    }
  }
  return processors;
}

describe('fallback mixer scene presets', () => {
  it('only reference processors available in the fallback realtime insert catalog', () => {
    const fallbackProcessors = new Set(FALLBACK_INSERT_CATALOG);
    const invalid: string[] = [];

    for (const preset of FALLBACK_MIXER_SCENE_PRESETS) {
      for (const processor of sceneProcessors(loadMixerScenePresetJson(preset))) {
        if (!fallbackProcessors.has(processor)) invalid.push(`${preset}:${processor}`);
      }
    }

    expect(invalid).toEqual([]);
  });
});

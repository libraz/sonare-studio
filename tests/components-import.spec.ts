import { describe, expect, it } from 'vitest';

const componentModules = import.meta.glob('../src/components/**/*.vue');

describe('component template import gate', () => {
  it('compiles and loads every Vue SFC module', async () => {
    const entries = Object.entries(componentModules);
    expect(entries.length).toBeGreaterThanOrEqual(100);

    const loaded = await Promise.all(entries.map(async ([path, load]) => [path, await load()]));
    for (const [path, module] of loaded) {
      expect(path).toMatch(/\.vue$/);
      expect(module).toHaveProperty('default');
    }
  });
});

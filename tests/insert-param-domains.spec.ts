import { describe, expect, it } from 'vitest';
import {
  INSERT_PARAM_DOMAIN_FALLBACK,
  insertParamDomain,
  insertParamDomainEntries,
  insertParamDomainForStrip,
} from '@/project/insert-param-domains';
import type { InsertSlot } from '@/project/mixer';
import { FAKE_INSERT_PARAMS } from './fake-wasm';

/** Strip-shaped value carrying a single insert slot. */
function stripWith(processor: string): { inserts: InsertSlot[] } {
  return { inserts: [{ processor, params: {}, enabled: true }] };
}

describe('insertParamDomain', () => {
  it('only declares domains for parameter names the engine catalog exposes', () => {
    for (const { processor, paramName } of insertParamDomainEntries().filter(
      (entry) => FAKE_INSERT_PARAMS[entry.processor] !== undefined,
    )) {
      expect(FAKE_INSERT_PARAMS[processor], `${processor}.${paramName}`).toContain(paramName);
    }
  });

  it('returns the catalogued domain for a known processor parameter', () => {
    expect(insertParamDomain('dynamics.compressor', 'thresholdDb')).toEqual({
      min: -60,
      max: 0,
      unit: 'dB',
    });
    expect(insertParamDomain('dynamics.compressor', 'makeupGainDb')).toEqual({
      min: -12,
      max: 24,
      unit: 'dB',
    });
    expect(insertParamDomain('stereo.imager', 'width')).toEqual({ min: 0, max: 2, unit: '' });
  });

  it('falls back to the neutral window for unknown processors or parameters', () => {
    expect(insertParamDomain('unknown.proc', 'whatever')).toBe(INSERT_PARAM_DOMAIN_FALLBACK);
    // 'makeupDb'/'mix' are not real compressor params; only catalogued names hit.
    expect(insertParamDomain('dynamics.compressor', 'mix')).toBe(INSERT_PARAM_DOMAIN_FALLBACK);
    expect(insertParamDomain('dynamics.compressor', 'makeupDb')).toBe(INSERT_PARAM_DOMAIN_FALLBACK);
  });
});

describe('insertParamDomainForStrip', () => {
  it('resolves the addressed slot processor parameter domain', () => {
    expect(
      insertParamDomainForStrip(stripWith('dynamics.compressor'), 'insert:0:thresholdDb'),
    ).toEqual({ min: -60, max: 0, unit: 'dB' });
  });

  it('returns undefined for a fader/pan param', () => {
    expect(insertParamDomainForStrip(stripWith('dynamics.compressor'), 'faderDb')).toBeUndefined();
    expect(insertParamDomainForStrip(stripWith('dynamics.compressor'), 'pan')).toBeUndefined();
  });

  it('returns undefined when the strip or the addressed slot is absent', () => {
    expect(insertParamDomainForStrip(undefined, 'insert:0:thresholdDb')).toBeUndefined();
    expect(
      insertParamDomainForStrip(stripWith('dynamics.compressor'), 'insert:3:thresholdDb'),
    ).toBeUndefined();
  });

  it('falls back to the neutral domain for an uncatalogued slot parameter', () => {
    expect(insertParamDomainForStrip(stripWith('dynamics.compressor'), 'insert:0:detector')).toBe(
      INSERT_PARAM_DOMAIN_FALLBACK,
    );
  });
});

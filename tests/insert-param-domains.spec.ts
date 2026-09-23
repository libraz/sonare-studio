import { describe, expect, it } from 'vitest';
import {
  INSERT_PARAM_DOMAIN_FALLBACK,
  insertParamDomain,
  insertParamDomainEntries,
} from '@/project/insert-param-domains';
import { FAKE_INSERT_PARAMS } from './fake-wasm';

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

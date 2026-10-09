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

  it('keeps a window only for a parameter the descriptor leaves open', () => {
    expect(insertParamDomain('saturation.softClipper', 'ceiling')).toEqual({
      min: 0,
      max: 1,
      unit: '',
    });
    // Covered by the descriptor's uiMin/uiMax, so no hand window remains.
    expect(insertParamDomain('dynamics.compressor', 'thresholdDb')).toBe(
      INSERT_PARAM_DOMAIN_FALLBACK,
    );
  });

  it('falls back to the neutral window for unknown processors or parameters', () => {
    expect(insertParamDomain('unknown.proc', 'whatever')).toBe(INSERT_PARAM_DOMAIN_FALLBACK);
    // 'makeupDb'/'mix' are not real compressor params; only catalogued names hit.
    expect(insertParamDomain('dynamics.compressor', 'mix')).toBe(INSERT_PARAM_DOMAIN_FALLBACK);
    expect(insertParamDomain('dynamics.compressor', 'makeupDb')).toBe(INSERT_PARAM_DOMAIN_FALLBACK);
  });
});

import { describe, expect, it, vi } from 'vitest';
import {
  INSERT_PARAM_DOMAIN_FALLBACK,
  insertParamDomain,
  insertParamDomainEntries,
} from '@/project/insert-param-domains';
import { coreWasmBinary } from './core-package';
import {
  FAKE_INSERT_PARAMS,
  FAKE_OFFLINE_PROCESSOR_PARAMS,
  FAKE_UNMIRRORED_INSERTS,
} from './fake-wasm';

describe('packed insert parameter catalog', () => {
  it('matches every fake parameter row to the shipped descriptors', async () => {
    const actual = await vi.importActual<typeof import('@libraz/libsonare')>('@libraz/libsonare');
    await actual.init({ wasmBinary: coreWasmBinary() });
    const insertNames = actual.masteringInsertNames();
    const shipped: readonly string[] = insertNames;
    const processorCatalog = actual.masteringProcessorCatalog();

    const differences: Array<{
      processor: string;
      missing: string[];
      extra: string[];
    }> = [];
    const compare = (processor: string, packedNames: string[], fakeNames: string[] | undefined) => {
      const fake = new Set(fakeNames ?? []);
      const packed = new Set(packedNames);
      const missing = [...packed].filter((name) => !fake.has(name)).sort();
      const extra = [...fake].filter((name) => !packed.has(name)).sort();
      if (fakeNames === undefined || missing.length || extra.length) {
        differences.push({ processor, missing, extra });
      }
    };
    // A shipped insert is either mirrored exactly or listed as unmirrored, so a new one forces a choice.
    for (const insert of insertNames) {
      if (FAKE_INSERT_PARAMS[insert] === undefined && FAKE_UNMIRRORED_INSERTS.includes(insert))
        continue;
      compare(insert, actual.masteringInsertParamNames(insert), FAKE_INSERT_PARAMS[insert]);
    }
    for (const insert of FAKE_UNMIRRORED_INSERTS) {
      if (!shipped.includes(insert) || FAKE_INSERT_PARAMS[insert] !== undefined) {
        differences.push({ processor: insert, missing: [], extra: ['listed as unmirrored'] });
      }
    }
    for (const processor of Object.keys(FAKE_INSERT_PARAMS)) {
      if (!shipped.includes(processor)) {
        differences.push({
          processor,
          missing: [],
          extra: [...FAKE_INSERT_PARAMS[processor]].sort(),
        });
      }
    }
    // The fake catalog carries a chosen subset of the offline processors.
    for (const [processor, fakeNames] of Object.entries(FAKE_OFFLINE_PROCESSOR_PARAMS)) {
      const entry = processorCatalog.find((candidate) => candidate.id === processor);
      const descriptors =
        entry?.offlineParams ?? (entry?.kind === 'offline' ? entry.params : undefined);
      if (!descriptors) {
        differences.push({ processor, missing: [], extra: [...fakeNames].sort() });
        continue;
      }
      compare(
        processor,
        descriptors.map((descriptor) =>
          typeof descriptor === 'string' ? descriptor : descriptor.name,
        ),
        fakeNames,
      );
    }
    expect(differences, 'fake insert rows must match the packed catalog').toEqual([]);
  });
});

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

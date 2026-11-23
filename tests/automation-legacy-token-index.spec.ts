import { describe, expect, it } from 'vitest';
import {
  insertAutomationParam,
  masteringAutomationParam,
  parseInsertAutomationParam,
  parseMasteringAutomationParam,
} from '@/project/automation';

const MALFORMED = ['', ' 1', '1e0', '0x1', '1.0', '+1', '-0'];

describe('legacy automation token indices', () => {
  it.each(MALFORMED)('reject the insert index %j', (index) => {
    expect(parseInsertAutomationParam(`insert:${index}:cutoff`)).toBeUndefined();
  });

  it.each(MALFORMED)('reject the mastering index %j', (index) => {
    expect(parseMasteringAutomationParam(`mastering:${index}:gain`)).toBeUndefined();
  });

  it('round-trip the indices the encoders write', () => {
    expect(parseInsertAutomationParam(insertAutomationParam(12, 'a:b'))).toEqual({
      insertIndex: 12,
      paramName: 'a:b',
    });
    expect(parseMasteringAutomationParam(masteringAutomationParam(0, 'gain'))).toEqual({
      processorIndex: 0,
      paramName: 'gain',
    });
  });
});

import { describe, expect, it } from 'vitest';
import { parseRunnerArgs } from '../scripts/e2e/args.mjs';

const NAMES = ['boot', 'piano-roll', 'score', 'export'];

describe('parseRunnerArgs', () => {
  it('runs every scenario with no arguments', () => {
    expect(parseRunnerArgs([], NAMES)).toEqual({
      baseUrl: undefined,
      list: false,
      selected: NAMES,
    });
  });

  it('takes --only with or without an equals sign, in running order', () => {
    for (const argv of [['--only=score,boot'], ['--only', 'score,boot']]) {
      expect(parseRunnerArgs(argv, NAMES).selected).toEqual(['boot', 'score']);
    }
  });

  it('takes --through with or without an equals sign', () => {
    for (const argv of [['--through=piano-roll'], ['--through', 'piano-roll']]) {
      expect(parseRunnerArgs(argv, NAMES).selected).toEqual(['boot', 'piano-roll']);
    }
  });

  it('reads one base URL and --list', () => {
    expect(parseRunnerArgs(['http://localhost:5299', '--list'], NAMES)).toMatchObject({
      baseUrl: 'http://localhost:5299',
      list: true,
    });
  });

  it.each([
    [['--onyl=boot']],
    [['--only=boot', '--through=score']],
    [['--only=nope']],
    [['--through=nope']],
    [['http://a', 'http://b']],
  ])('refuses %j', (argv) => {
    expect(() => parseRunnerArgs(argv, NAMES)).toThrow();
  });
});

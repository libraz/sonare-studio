/**
 * Command-line arguments of the E2E runner, shared by `scripts/e2e-smoke.mjs`
 * and the `yarn e2e` launcher so both accept and refuse the same things.
 *
 * Accepted: `--list`, `--only=<a,b>` or `--only <a,b>`, `--through=<name>` or
 * `--through <name>`, and one positional base URL. Anything else, an unknown
 * scenario, or `--only` together with `--through` is refused rather than ignored.
 */
import { parseArgs } from 'node:util';

/**
 * @param {string[]} argv The arguments after the script path.
 * @param {string[]} names Every scenario name, in running order.
 * @returns {{ baseUrl: string | undefined, list: boolean, selected: string[] }}
 *   `selected` keeps the running order.
 */
export function parseRunnerArgs(argv, names) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      list: { type: 'boolean', default: false },
      only: { type: 'string' },
      through: { type: 'string' },
    },
  });
  if (positionals.length > 1) {
    throw new Error(`Expected at most one base URL, got: ${positionals.join(' ')}`);
  }
  if (values.only !== undefined && values.through !== undefined) {
    throw new Error('Pass --only or --through, not both');
  }
  let selected = names;
  if (values.only !== undefined) {
    const wanted = new Set(values.only.split(',').map((part) => part.trim()));
    const unknown = [...wanted].filter((name) => !names.includes(name));
    if (unknown.length > 0) throw new Error(`Unknown scenario(s): ${unknown.join(', ')}`);
    selected = names.filter((name) => wanted.has(name));
  } else if (values.through !== undefined) {
    const end = names.indexOf(values.through);
    if (end < 0) throw new Error(`Unknown scenario: ${values.through}`);
    selected = names.slice(0, end + 1);
  }
  return { baseUrl: positionals[0], list: values.list, selected };
}

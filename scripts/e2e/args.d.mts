/** Parsed E2E runner arguments; see args.mjs. */
export interface RunnerArgs {
  baseUrl: string | undefined;
  list: boolean;
  selected: string[];
}

export function parseRunnerArgs(argv: string[], names: string[]): RunnerArgs;

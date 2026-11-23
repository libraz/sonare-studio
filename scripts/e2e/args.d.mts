/** Parsed E2E runner arguments; see args.mjs. */
export interface RunnerArgs {
  baseUrl: string | undefined;
  list: boolean;
  selected: string[];
  /** Rewrite the API map instead of checking it; full runs only. */
  updateApiMap: boolean;
}

export function parseRunnerArgs(argv: string[], names: string[]): RunnerArgs;

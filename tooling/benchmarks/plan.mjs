import { parseArgs } from 'node:util';

const commands = {
  main: 'pnpm test',
  e2e: 'pnpm test:e2e',
  browser: 'pnpm test:browser',
  full: 'pnpm test:full',
  workflows: 'pnpm --filter @luma/workflows exec vitest run',
};

/** Validates benchmark options and builds a fixed suite command with optional worker limits. */
export function benchmarkPlan(args) {
  const { values } = parseArgs({
    args,
    options: {
      suite: { type: 'string', default: 'browser' },
      runs: { type: 'string', default: '5' },
      warmup: { type: 'string', default: '1' },
      workers: { type: 'string' },
      label: { type: 'string', default: 'benchmark' },
      'show-output': { type: 'boolean', default: false },
    },
  });
  const integer = (name, minimum) => {
    const value = values[name];
    if (
      !/^\d+$/.test(value) ||
      !Number.isSafeInteger(Number(value)) ||
      Number(value) < minimum
    ) {
      throw new Error(`--${name} must be an integer >= ${minimum}.`);
    }

    return Number(value);
  };
  if (!Object.hasOwn(commands, values.suite))
    throw new Error(
      `--suite must be one of: ${Object.keys(commands).join(', ')}.`,
    );
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(values.label))
    throw new Error(
      '--label must contain 1–64 letters, digits, underscores or hyphens.',
    );
  let command = commands[values.suite];
  let workers;
  if (values.workers !== undefined) {
    if (!['browser', 'e2e'].includes(values.suite))
      throw new Error('--workers requires --suite browser or e2e.');
    workers = integer('workers', 1);
    command += ` --${values.suite === 'browser' ? 'workers' : 'maxWorkers'}=${workers}`;
  }

  return {
    suite: values.suite,
    command,
    workers,
    runs: integer('runs', 1),
    warmup: integer('warmup', 0),
    label: values.label,
    showOutput: values['show-output'],
  };
}

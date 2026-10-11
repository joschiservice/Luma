// Browser journeys and the simulator serve the web apps and control panel from build output.
const build = [
  'exec',
  'turbo',
  'run',
  'build',
  '--filter=@luma/api...',
  '--filter=@luma/worker...',
  '--filter=@luma/simulator...',
  '--filter=@luma/simulator-web',
  '--filter=@luma/staff-api...',
  '--filter=@luma/web',
  '--filter=@luma/staff-web',
];

/** @type {Record<string, string[][]>} */
const suites = {
  // Runs without provisioning PostgreSQL; database suites skip.
  local: [
    ['test:tooling'],
    ['test:architecture'],
    ['test:style'],
    ['exec', 'turbo', 'run', 'test'],
  ],
  test: [['test:local']],
  e2e: [build, ['--filter', '@luma/api', 'test:e2e']],
  browser: [build, ['--filter', '@luma/api', 'test:browser']],
  full: [
    ['setup:code'],
    ['check'],
    ['test:e2e'],
    ['test:browser'],
    ['test:simulator'],
    ['test:evaluation'],
    ['evaluate:playbook'],
    ['evaluate:code'],
  ],
  workflows: [
    [
      '--filter',
      '@luma/api',
      'test:e2e',
      'workflow',
      'playbooks',
      'code-steps',
      'replenishment',
    ],
    [
      '--filter',
      '@luma/api',
      'test:browser',
      'workflow|playbooks|code-steps|replenishment',
    ],
  ],
  orders: [
    [
      '--filter',
      '@luma/api',
      'test:browser',
      'orders.browser.mjs',
      'order-links.browser.mjs',
      'records.browser.mjs',
    ],
  ],
  // Simulator packages, host and installed-adapter contracts; the host needs PostgreSQL.
  'simulator-tooling': [
    [
      'exec',
      'turbo',
      'run',
      'build',
      '--filter=@luma/api...',
      '--filter=@luma/simulator...',
      '--filter=@luma/simulator-web',
    ],
    [
      'exec',
      'turbo',
      'run',
      'test',
      '--filter=@luma/simulator',
      '--filter=@luma/simulator-*',
    ],
    ['exec', 'node', '--test', 'tooling/simulator/*.test.mjs'],
  ],
  // Prebuilt platform suites used by verify:feature after its single build step.
  simulator: [
    [
      '--filter',
      '@luma/api',
      'test:e2e',
      'simulator.e2e.mjs',
      'case-workflows.e2e.mjs',
      'inbox.e2e.mjs',
    ],
    ['--filter', '@luma/api', 'test:browser', 'simulator.browser.mjs'],
  ],
  // The operations inbox against the simulated mailbox, used by verify:feature.
  inbox: [
    ['--filter', '@luma/api', 'test:e2e', 'inbox.e2e.mjs'],
    ['--filter', '@luma/api', 'test:browser', 'inbox.browser.mjs'],
  ],
};

/**
 * Journey filters: Vitest matches path substrings, Playwright matches path patterns.
 * @type {Record<'e2e' | 'browser', (files: string[]) => string[]>}
 */
const journeyFilters = {
  e2e: (files) => [...files.map((file) => `e2e/${file}`), '--passWithNoTests'],
  browser: (files) => [
    ...files.map((file) => `e2e/${file.replaceAll('.', '\\.')}$`),
    '--pass-with-no-tests',
  ],
};

/**
 * Returns isolated command arguments for a suite; rejects unsupported forwarding.
 * With `--affected`, unit tests run for affected Turbo tasks and journey suites run only the
 * selected journeys; a suite with no selected journeys returns no commands.
 * @param {string} suite
 * @param {string[]} extraArgs
 * @param {{ e2e: string[], browser: string[] }} [journeys] affected journey selection
 */
export function testCommands(suite, extraArgs = [], journeys) {
  if (suite === 'affected') {
    if (extraArgs.length)
      throw new Error('Test arguments are not supported for affected');

    /** @type {string[][]} */
    const e2e = testCommands('e2e', ['--affected'], journeys);
    /** @type {string[][]} */
    const browser = testCommands('browser', ['--affected'], journeys);

    // Both journey suites share one build.
    return [
      ['test:local', '--affected'],
      ...(e2e.length || browser.length ? [[...build]] : []),
      ...e2e.slice(1),
      ...browser.slice(1),
    ];
  }
  const commands = Object.hasOwn(suites, suite)
    ? suites[suite].map((args) => [...args])
    : undefined;
  if (!commands) throw new Error(`Unknown test suite: ${suite}`);
  if (!extraArgs.length) return commands;
  if (!['local', 'test', 'e2e', 'browser'].includes(suite))
    throw new Error(
      'Test arguments are supported only for local, test, e2e and browser',
    );
  let args = extraArgs;
  if ((suite === 'e2e' || suite === 'browser') && args.includes('--affected')) {
    if (!journeys) throw new Error('Affected journeys were not selected');
    if (!journeys[suite].length) return [];
    args = [
      ...args.filter((arg) => arg !== '--affected'),
      ...journeyFilters[suite](journeys[suite]),
    ];
  }
  commands[commands.length - 1].push(...args);

  return commands;
}

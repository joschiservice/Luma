/** @type {Record<string, string[][]>} */
const suites = {
  test: [['test:local']],
  e2e: [
    [
      'exec',
      'turbo',
      'run',
      'build',
      '--filter=@luma/api...',
      '--filter=@luma/worker...',
      '--filter=@luma/simulator...',
    ],
    ['--filter', '@luma/api', 'test:e2e'],
  ],
  browser: [
    [
      'exec',
      'turbo',
      'run',
      'build',
      '--filter=@luma/api...',
      '--filter=@luma/worker...',
      '--filter=@luma/simulator...',
    ],
    ['--filter', '@luma/api', 'test:browser'],
  ],
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
    ],
    ['--filter', '@luma/api', 'test:browser', 'simulator.browser.mjs'],
  ],
};

/**
 * Returns isolated command arguments for a suite; rejects unsupported forwarding.
 * @param {string} suite
 * @param {string[]} extraArgs
 */
export function testCommands(suite, extraArgs = []) {
  const commands = Object.hasOwn(suites, suite)
    ? suites[suite].map((args) => [...args])
    : undefined;
  if (!commands) throw new Error(`Unknown test suite: ${suite}`);
  if (extraArgs.length) {
    if (!['test', 'e2e', 'browser'].includes(suite))
      throw new Error(
        'Test arguments are supported only for test, e2e and browser',
      );
    commands[commands.length - 1].push(...extraArgs);
  }

  return commands;
}

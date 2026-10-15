import { mkdtemp, open, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fail, run } from './process.mjs';

try {
  const feature = process.argv[2];
  const packages = {
    simulator: [
      'simulator',
      'simulator-*',
      'app-starshipit',
      'connector-starshipit',
      'app-shopify',
      'connector-shopify',
      'commerce-ingestion',
      'commerce-sync',
      'resolution',
      'exceptions',
    ],
    'stock-protection': [
      'app-shopify',
      'app-cin7',
      'policies',
      'execution',
      'resolution',
      'exceptions',
      'workflow-temporal',
      'application-runtime',
      'api-contract',
      'web',
      'simulator',
      'simulator-shopify',
    ],
    workflows: [
      'workflows',
      'workflow-temporal',
      'execution',
      'policies',
      'resolution',
      'exceptions',
      'app-shopify',
      'procurement',
      'application-runtime',
      'api-contract',
      'web',
    ],
    orders: [
      'orders',
      'read-models',
      'commerce-ingestion',
      'application-runtime',
      'api-contract',
      'web',
    ],
    purchasing: [
      'procurement',
      'messaging',
      'execution',
      'policies',
      'inventory',
      'app-jtl',
      'connector-jtl',
      'app-shopify',
      'connector-shopify',
      'app-gmail',
      'connector-gmail',
      'simulator',
      'simulator-jtl',
      'simulator-gmail',
      'simulator-shopify',
      'application-runtime',
      'api-contract',
      'web',
    ],
    inbox: [
      'messaging',
      'app-gmail',
      'connector-gmail',
      'simulator',
      'simulator-gmail',
      'application-runtime',
      'api-contract',
      'web',
    ],
  };
  if (process.argv.length !== 3 || !Object.hasOwn(packages, feature))
    throw new Error(
      'Usage: pnpm verify:feature <simulator|workflows|orders|inbox|purchasing|stock-protection>',
    );

  const directory = await mkdtemp(join(tmpdir(), `luma-verify-${feature}-`));
  console.log(`Logs: ${directory}`);
  const filters = packages[feature].map((name) => `--filter=@luma/${name}`);
  const steps = [
    ['Code runtime', 'pnpm', ['setup:code']],
    ['Formatting', 'pnpm', ['format:check']],
    ['Lint', 'pnpm', ['lint']],
    [
      'Build',
      'pnpm',
      [
        'exec',
        'turbo',
        'run',
        'build',
        '--filter=@luma/api...',
        '--filter=@luma/simulator...',
        '--filter=@luma/simulator-web',
        '--filter=@luma/worker...',
        // Browser journeys serve the web app's build output.
        '--filter=@luma/web',
      ],
    ],
    [
      'Types',
      'pnpm',
      ['exec', 'turbo', 'run', 'typecheck', '--only', ...filters],
    ],
    ['Unit tests', 'pnpm', ['run', 'test', '--only', ...filters]],
    ...(feature === 'simulator'
      ? [
          [
            'Simulator host, adapters and panel',
            process.execPath,
            ['tooling/dev/test.mjs', 'simulator-tooling'],
          ],
        ]
      : []),
    [
      'Platform scenarios and browser journey',
      process.execPath,
      ['tooling/dev/test.mjs', feature],
    ],
  ];

  for (const [index, [label, command, args]] of steps.entries()) {
    const path = join(directory, `${index + 1}.log`);
    const log = await open(path, 'w', 0o600);
    console.log(`RUN   ${label}`);
    try {
      await log.write(`${command} ${args.join(' ')}\n\n`);
      await run(command, args, { logFd: log.fd });
      console.log(`PASS  ${label}`);
    } catch (error) {
      console.error(`FAIL  ${label}: ${path}`);
      if (![130, 143].includes(error.exitCode)) {
        const output = await readFile(path, 'utf8');
        console.error(output.trimEnd().split('\n').slice(-30).join('\n'));
      }
      throw error;
    } finally {
      await log.close();
    }
  }
  console.log(`Focused ${feature} checks passed. Full logs: ${directory}`);
} catch (error) {
  fail(error);
}

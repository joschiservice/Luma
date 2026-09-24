import { mkdtemp, open, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fail, root, run } from './process.mjs';

try {
  if (process.argv.length !== 3 || process.argv[2] !== 'simulator')
    throw new Error('Usage: pnpm verify:feature simulator');

  const directory = await mkdtemp(join(tmpdir(), 'luma-verify-simulator-'));
  console.log(`Logs: ${directory}`);
  const simulatorTests = (await readdir(join(root, 'tooling/simulator')))
    .filter((name) => name.endsWith('.test.mjs'))
    .sort()
    .map((name) => `tooling/simulator/${name}`);
  const filters = [
    '--filter=@luma/simulator',
    '--filter=@luma/simulator-*',
    '--filter=@luma/resolution',
    '--filter=@luma/exceptions',
  ];
  const steps = [
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
      ],
    ],
    [
      'Types',
      'pnpm',
      ['exec', 'turbo', 'run', 'typecheck', '--only', ...filters],
    ],
    [
      'Unit tests',
      'pnpm',
      ['exec', 'turbo', 'run', 'test', '--only', ...filters],
    ],
    [
      'Simulator integration and panel',
      process.execPath,
      ['--test', ...simulatorTests],
    ],
    [
      'Platform scenarios and browser journey',
      process.execPath,
      ['tooling/dev/test.mjs', 'simulator'],
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
  console.log(`Focused simulator checks passed. Full logs: ${directory}`);
} catch (error) {
  fail(error);
}

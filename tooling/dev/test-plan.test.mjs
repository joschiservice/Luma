import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { parse } from 'yaml';

import { testCommands } from './test-plan.mjs';

const manifest = JSON.parse(
  await readFile(new URL('../../package.json', import.meta.url)),
);

/** Lists a suite's commands, including those that run together. */
const commandsOf = (suite) =>
  testCommands(suite).flatMap((step) =>
    Array.isArray(step) ? [step] : step.parallel,
  );

function leaves(command) {
  return command.split(' && ').flatMap((part) => {
    // Full runs journeys directly after its single build.
    const journey = part.match(
      /^pnpm --filter @luma\/api (test:e2e|test:browser)(?: .*)?$/,
    );
    if (journey) return [journey[1]];
    const match = part.match(/^pnpm (?:run )?([\w:-]+)(?: .*)?$/);
    if (match && manifest.scripts[match[1]]) {
      if (match[1] === 'check')
        return commandsOf('check').flatMap((args) =>
          leaves(`pnpm ${args.join(' ')}`),
        );
      if (['test', 'test:local'].includes(match[1]))
        return commandsOf('local').flatMap((args) =>
          leaves(`pnpm ${args.join(' ')}`),
        );
      if (['test:e2e', 'test:browser'].includes(match[1])) return [match[1]];

      return leaves(manifest.scripts[match[1]]);
    }

    // The UI-only job is also exercised by the unfiltered local Turbo test task.
    return [
      part.replace(/^pnpm exec /, '').replace(/ --filter=@luma\/ui$/, ''),
    ];
  });
}

test('full validation covers every CI matrix command', async () => {
  const ci = parse(
    await readFile(
      new URL('../../.github/workflows/ci.yml', import.meta.url),
      'utf8',
    ),
  );
  const full = new Set(
    commandsOf('full').flatMap((args) => leaves(`pnpm ${args.join(' ')}`)),
  );
  for (const job of ci.jobs.checks.strategy.matrix.include) {
    for (const command of leaves(job.command))
      assert.ok(full.has(command), `${job.name}: missing ${command}`);
  }
});

test('forwarded filters do not leak into later invocations', () => {
  assert.deepEqual(testCommands('browser', ['--workers=1']).at(-1), [
    '--filter',
    '@luma/api',
    'test:browser',
    '--workers=1',
  ]);
  assert.ok(!testCommands('browser').at(-1).includes('--workers=1'));
  assert.throws(() => testCommands('full', ['--shard=1/2']), /arguments/);
  assert.throws(() => testCommands('affected', ['--shard=1/2']), /arguments/);
  assert.throws(() => testCommands('missing'), /Unknown/);
});

test('affected journey suites run only selected files', () => {
  const journeys = {
    e2e: ['orders.e2e.mjs'],
    browser: ['orders.browser.mjs', 'records.browser.mjs'],
  };
  assert.deepEqual(
    testCommands('e2e', ['--affected', '--shard=1/2'], journeys).at(-1),
    [
      '--filter',
      '@luma/api',
      'test:e2e',
      '--shard=1/2',
      'e2e/orders.e2e.mjs',
      '--passWithNoTests',
    ],
  );
  assert.deepEqual(
    testCommands('browser', ['--affected'], journeys).at(-1).slice(3),
    [
      'e2e/orders\\.browser\\.mjs$',
      'e2e/records\\.browser\\.mjs$',
      '--pass-with-no-tests',
    ],
  );
  assert.deepEqual(
    testCommands('e2e', ['--affected'], { e2e: [], browser: [] }),
    [],
  );
  assert.throws(() => testCommands('e2e', ['--affected']), /not selected/);
});

test('affected suite builds once and skips empty journey suites', () => {
  const unitOnly = testCommands('affected', [], { e2e: [], browser: [] });
  assert.deepEqual(unitOnly, [['test:local', '--affected']]);

  const browserOnly = testCommands('affected', [], {
    e2e: [],
    browser: ['orders.browser.mjs'],
  });
  assert.equal(browserOnly.length, 3);
  assert.equal(browserOnly[1][3], 'build');
  assert.deepEqual(browserOnly[2].slice(0, 3), [
    '--filter',
    '@luma/api',
    'test:browser',
  ]);
});

test('component tests keep forwarded story filters', () => {
  assert.deepEqual(testCommands('ui', ['orders.stories.tsx']), [
    ['--filter', '@luma/ui', 'test', 'orders.stories.tsx'],
  ]);
});

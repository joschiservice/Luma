import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { parse } from 'yaml';

import { testCommands } from './test-plan.mjs';

const manifest = JSON.parse(
  await readFile(new URL('../../package.json', import.meta.url)),
);

function leaves(command) {
  return command.split(' && ').flatMap((part) => {
    const match = part.match(/^pnpm (?:run )?([\w:-]+)(?: .*)?$/);
    if (match && manifest.scripts[match[1]]) {
      if (match[1] === 'test') return leaves(manifest.scripts['test:local']);
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
    testCommands('full').flatMap((args) => leaves(`pnpm ${args.join(' ')}`)),
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
  assert.throws(() => testCommands('missing'), /Unknown/);
});

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

test('simulator validates startup before loading unbuilt workspace packages', () => {
  const cli = new URL('../simulator/cli.mjs', import.meta.url).href;
  for (const scenario of [
    {
      environment: 'production',
      args: [],
      message: 'Simulator is for local development',
    },
    {
      environment: 'development',
      args: ['--erp', 'unsupported'],
      message: '--erp must be jtl or cin7',
    },
  ]) {
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `
          import { registerHooks } from 'node:module';
          registerHooks({
            resolve(specifier, context, nextResolve) {
              if (specifier.startsWith('@luma/') || specifier.includes('/dist/'))
                throw new Error('Workspace build output is unavailable: ' + specifier);
              return nextResolve(specifier, context);
            },
          });
          process.argv = [process.execPath, ...${JSON.stringify(scenario.args)}];
          await import(${JSON.stringify(cli)});
        `,
      ],
      {
        env: { ...process.env, NODE_ENV: scenario.environment },
        encoding: 'utf8',
        timeout: 10_000,
      },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.equal(result.stderr.trim(), scenario.message);
  }
});

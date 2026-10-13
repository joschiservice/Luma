import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { test } from 'node:test';
import { promisify } from 'node:util';

const run = promisify(execFile);
const command = new URL('red-team-propose-cli.mjs', import.meta.url).pathname;
const args = [
  command,
  '00000000-0000-4000-8000-000000000001',
  'unused-corpus.json',
  'unused-proposals.json',
];

test('proposal CLI evaluates the default-off tenant release before reading a corpus or calling a model', async () => {
  for (const override of [undefined, 'workflow-red-teaming=false'])
    await assert.rejects(
      run(process.execPath, args, {
        timeout: 10000,
        env: {
          PATH: process.env.PATH,
          OBSERVABILITY_ENVIRONMENT: 'test',
          ...(override ? { FEATURE_FLAG_OVERRIDES: override } : {}),
        },
      }),
      (error) =>
        error.code === 1 &&
        error.stderr.includes('Workflow red teaming is disabled.'),
    );
});

test('an enabled development release still requires the approved EU model route, and production overrides are rejected', async () => {
  await assert.rejects(
    run(process.execPath, args, {
      timeout: 10000,
      env: {
        PATH: process.env.PATH,
        OBSERVABILITY_ENVIRONMENT: 'test',
        FEATURE_FLAG_OVERRIDES: 'workflow-red-teaming=true',
      },
    }),
    (error) =>
      error.code === 1 &&
      error.stderr.includes(
        'Configure the EU zero-retention authoring route first.',
      ),
  );
  await assert.rejects(
    run(process.execPath, args, {
      timeout: 10000,
      env: {
        PATH: process.env.PATH,
        OBSERVABILITY_ENVIRONMENT: 'production',
        FEATURE_FLAG_OVERRIDES: 'workflow-red-teaming=true',
      },
    }),
    (error) =>
      error.code === 1 &&
      error.stderr.includes(
        'FEATURE_FLAG_OVERRIDES requires development or test',
      ),
  );
});

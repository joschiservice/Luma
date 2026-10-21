import { join } from 'node:path';

import { expect, test } from 'vitest';

import { waitFor } from '../../../tooling/pilot/journey.mjs';
import { startProcess, until } from './helpers.mjs';
import { pilotFixture } from './pilot-fixture.mjs';

const { setup, temporalAddress } = pilotFixture();

test('worker death after provider commit reconciles without a second PATCH', async (t) => {
  const f = await setup(t, 'recovery');
  const script = new URL('../../../tooling/pilot/process.mjs', import.meta.url)
    .pathname;
  // Use a small entrypoint because the E2E process helper accepts one script path.
  const { writeFile } = await import('node:fs/promises');
  const entry = join(f.directory, 'worker.mjs');
  await writeFile(
    entry,
    `process.argv.push('--worker'); await import(${JSON.stringify(script)});`,
  );
  const env = {
    ...f.env,
    LUMA_PILOT_DIRECTORY: f.directory,
    TEMPORAL_ADDRESS: temporalAddress(),
  };
  const first = startProcess(t, entry, env);
  await until(
    async () =>
      (await f.pilot.provider()).effects.length === 1 ||
      (first.result &&
        (() => {
          throw new Error(first.output);
        })()),
    'provider commit',
    30_000,
  );
  first.child.kill('SIGKILL');
  await first.wait();
  const second = startProcess(t, entry, env);
  const source = {
    kind: 'incident',
    id: f.manifest.incidents.workflow_failure,
  };
  const actor = await f.pilot.context();
  await waitFor(async () => {
    if (second.result) throw new Error(second.output);

    return (await f.client.progress(actor, source))?.phase === 'resolved';
  }, 90_000);
  expect((await f.pilot.provider()).effects).toHaveLength(1);
  expect((await f.pilot.provider()).patchRequests).toBe(1);
  expect(
    await f.pilot.detection.exceptions.get(actor, source.id),
  ).toMatchObject({ state: 'resolved', resolution: { kind: 'verification' } });
}, 120_000);

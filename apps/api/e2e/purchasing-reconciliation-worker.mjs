import { createObservability } from '@luma/platform/composition';

import { createPilot } from '../../../tooling/pilot/runtime.mjs';

let pilot;
let task = Promise.resolve();

/** Receives private fixture configuration only through IPC and runs the production reconciliation services. */
process.on('message', (message) => {
  task = task
    .then(async () => {
      if (message.type === 'start') {
        const flags = Object.fromEntries(
          (message.env.FEATURE_FLAG_OVERRIDES ?? '')
            .split(',')
            .filter(Boolean)
            .map((entry) => {
              const [key, value] = entry.split('=');

              return [key, value === 'true'];
            }),
        );
        pilot = await createPilot(
          message.env,
          message.directory,
          message.manifest,
          null,
          {
            role: 'worker',
            observability: createObservability({
              environment: 'test',
              release: 'test',
              sampleRate: 0,
              featureFlagOverrides: flags,
            }),
          },
        );
      } else if (message.type === 'pass') {
        await pilot.followUp();
        // The installed mailbox belongs to the seeded workspace owner. Each pass still resolves
        // the persisted message requester and refreshes their current permissions before a read.
        await pilot.messaging.replies.pass(await pilot.context());
        await pilot.messaging.replies.pass(await pilot.operator());
      }
      process.send({ id: message.id, ready: true });
    })
    .catch(() => {
      // The parent has the assertion and provider evidence. Credentials never become worker output.
      process.send({ id: message.id, ready: false });
    });
});

process.once('SIGTERM', async () => {
  await task;
  await pilot?.close();
  process.exit(0);
});
process.once('disconnect', async () => {
  await task;
  await pilot?.close();
  process.exit(0);
});

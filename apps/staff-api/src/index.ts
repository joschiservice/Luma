import { randomUUID } from 'node:crypto';

import { readObservabilityConfig } from '@luma/config';
import { createFailureLog } from '@luma/platform';
import { createObservability } from '@luma/platform/composition';
import { createStaff, readStaffSettings } from '@luma/staff/composition';

import { createStaffHttpApp } from './composition/http-app.js';

const settings = readStaffSettings();
const observability = createObservability(readObservabilityConfig(process.env));
const log = createFailureLog(observability);
const staff = createStaff(settings, {
  onDatabaseError: (error) => log('Staff database connection failed', error),
  release: async () => {
    const observation = observability.request(randomUUID());
    try {
      return await observability.flag(
        observation.context,
        'staff-regional-directory',
        false,
      );
    } finally {
      observation.end();
    }
  },
});
const app = createStaffHttpApp(staff, settings.trustedProxy ?? []);
app.addHook('onClose', () => observability.shutdown());
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    void app.close();
  });
try {
  if (!(await staff.checkReadiness()))
    throw new Error('Staff database privileges or schema are unsafe.');
  const address = await app.listen({
    host: settings.host,
    port: settings.port,
  });
  process.send?.({ type: 'listening', address });
  process.channel?.unref();
} catch {
  app.log.error('Staff API failed to start.');
  await app.close();
  process.exitCode = 1;
}

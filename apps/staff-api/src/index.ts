import { createStaff, readStaffSettings } from '@luma/staff/composition';

import { createStaffHttpApp } from './composition/http-app.js';

const settings = readStaffSettings();
const staff = createStaff(settings);
const app = createStaffHttpApp(staff, settings.trustedProxy ?? []);
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

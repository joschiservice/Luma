import { randomUUID } from 'node:crypto';

import { createStaff, readStaffSettings } from '@luma/staff/composition';
import { registerStaffHttp } from '@luma/staff/http';
import Fastify, { LogController } from 'fastify';

const settings = readStaffSettings();
const staff = createStaff(settings);
const app = Fastify({
  logger: {
    serializers: {
      req: (request: { method: string; url: string }) => ({
        method: request.method,
        url: request.url.split('?')[0] ?? '/',
      }),
    },
  },
  logController: new LogController({ disableRequestLogging: true }),
  genReqId: () => randomUUID(),
  bodyLimit: 16 * 1024,
  trustProxy: false,
});
registerStaffHttp(app, staff);
app.addHook('onClose', () => staff.close());
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

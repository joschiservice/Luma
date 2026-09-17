import { readApiConfig, readIdentityConfig } from '@luma/config';
import { buildRuntimeApp } from './app.js';

const config = readApiConfig(process.env);
const app = buildRuntimeApp(readIdentityConfig(process.env), {
  logger: {
    level: config.logLevel,
    redact: [
      'req.headers.cookie',
      'req.headers.authorization',
      'res.headers.set-cookie',
    ],
  },
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close().catch((error: unknown) => {
      app.log.error(error);
      process.exitCode = 1;
    });
  });
}

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error(error);
  await app.close();
  process.exitCode = 1;
}

import { readApiConfig } from '@luma/config';
import { buildApp } from './app.js';

const config = readApiConfig(process.env);
const app = buildApp({ logger: { level: config.logLevel } });

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
  process.exitCode = 1;
}

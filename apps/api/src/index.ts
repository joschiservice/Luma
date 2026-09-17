import {
  readApiConfig,
  readIdentityConfig,
  readObservabilityConfig,
} from '@luma/config';
import { createObservability } from './modules/platform/composition.js';
import { buildRuntimeApp } from './app.js';

const config = readApiConfig(process.env);
const identityConfig = readIdentityConfig(process.env);
const observability = createObservability(readObservabilityConfig(process.env));
const app = buildRuntimeApp(
  identityConfig,
  {
    logger: {
      level: config.logLevel,
      redact: [
        'req.headers.cookie',
        'req.headers.authorization',
        'res.headers.set-cookie',
      ],
    },
  },
  observability,
);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close().catch(() => {
      app.log.error('Shutdown failed');
      process.exitCode = 1;
    });
  });
}

try {
  await app.listen({ host: config.host, port: config.port });
} catch {
  app.log.error('API startup failed');
  await app.close();
  process.exitCode = 1;
}

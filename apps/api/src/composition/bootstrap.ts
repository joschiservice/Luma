import { register } from 'node:module';

import { readObservabilityConfig } from '@luma/config';

// Electron-based terminals can leave this flag on ordinary Node child processes;
// native profilers otherwise select an Electron binary instead of the Node ABI.
const settings = readObservabilityConfig(process.env);
if (settings.local && !process.versions.electron)
  delete process.env.ELECTRON_RUN_AS_NODE;
if (settings.local)
  register('@opentelemetry/instrumentation/hook.mjs', import.meta.url);
// Load the application only after instrumentation has installed its module hooks.
const { startLocalTelemetry } = await import('#modules/platform/composition');
const telemetry = await startLocalTelemetry(
  settings,
  process.argv.includes('--workflow-worker') ? 'luma-worker' : 'luma-api',
);
try {
  const { main } = await import('../index.js');
  await main(telemetry);
} catch (error) {
  await telemetry?.shutdown();
  throw error;
}

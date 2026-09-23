import { createRequire, register } from 'node:module';

const require = createRequire(
  new URL('../../apps/api/package.json', import.meta.url),
);

/** Starts local diagnostics before loading pilot or simulator application modules. */
export async function startTelemetry(env, serviceName) {
  const { readObservabilityConfig } =
    await import('../../packages/config/dist/index.js');
  const settings = readObservabilityConfig(env);
  if (!settings.local) return { settings };
  if (!process.versions.electron) delete process.env.ELECTRON_RUN_AS_NODE;
  register(
    require.resolve('@opentelemetry/instrumentation/hook.mjs'),
    import.meta.url,
  );
  const { startLocalTelemetry } = await import('@luma/platform/composition');
  const telemetry = await startLocalTelemetry(settings, serviceName);

  return { settings, telemetry };
}

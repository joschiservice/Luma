import { featureFlags } from '@luma/platform';

/** Evaluates explicit local overrides when a synthetic fixture has no telemetry runtime. */
export function syntheticFeatureRelease(env, fallback) {
  if (env.NODE_ENV === 'production' || process.env.NODE_ENV === 'production')
    throw new Error(
      'Synthetic feature overrides are unavailable in production',
    );
  const entries = (env.FEATURE_FLAG_OVERRIDES ?? '').split(',').filter(Boolean);
  const overrides = new Map(
    entries.map((entry) => {
      const match = /^([a-z][a-z0-9-]*)=(true|false)$/.exec(entry);
      if (!match || !featureFlags.includes(match[1]))
        throw new Error('Invalid synthetic feature override');

      return [match[1], match[2] === 'true'];
    }),
  );

  if (overrides.size !== entries.length)
    throw new Error('Duplicate synthetic feature override');

  return async (tenantId, flag) =>
    overrides.has(flag)
      ? overrides.get(flag)
      : ((await fallback?.(tenantId, flag)) ?? false);
}

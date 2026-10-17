/**
 * Validates a Valkey server URL setting named `name`, with its `cluster` flag setting. Returns
 * undefined when the URL is unset. Credentials are never public configuration.
 */
export function readValkeyUrl(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  clusterName: string,
): { url: string; cluster: boolean } | undefined {
  const value = env[name];
  const cluster = env[clusterName];
  if (cluster !== undefined && !['true', 'false'].includes(cluster))
    throw new Error(`${clusterName} must be true or false`);
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (
      !['redis:', 'rediss:'].includes(url.protocol) ||
      !url.hostname ||
      (url.pathname !== '' && url.pathname !== '/') ||
      url.search ||
      url.hash ||
      (url.username && !url.password)
    )
      throw new Error();

    return { url: url.toString(), cluster: cluster === 'true' };
  } catch {
    throw new Error(
      `${name} must be a redis:// or rediss:// server URL without a database, query or fragment`,
    );
  }
}

/** Validates the region-local coordinator URL. Credentials are never public configuration. */
export function readRequestAdmissionConfig(
  env: Readonly<Record<string, string | undefined>>,
): { url: string; cluster: boolean } | undefined {
  return readValkeyUrl(
    env,
    'SHOPIFY_ADMISSION_URL',
    'SHOPIFY_ADMISSION_CLUSTER',
  );
}

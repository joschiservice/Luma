/** Validates the region-local coordinator URL. Credentials are never public configuration. */
export function readRequestAdmissionConfig(
  env: Readonly<Record<string, string | undefined>>,
): { url: string; cluster: boolean } | undefined {
  if (
    env.SHOPIFY_ADMISSION_CLUSTER !== undefined &&
    !['true', 'false'].includes(env.SHOPIFY_ADMISSION_CLUSTER)
  )
    throw new Error('SHOPIFY_ADMISSION_CLUSTER must be true or false');
  if (!env.SHOPIFY_ADMISSION_URL) return undefined;
  try {
    const url = new URL(env.SHOPIFY_ADMISSION_URL);
    if (
      !['redis:', 'rediss:'].includes(url.protocol) ||
      !url.hostname ||
      (url.pathname !== '' && url.pathname !== '/') ||
      url.search ||
      url.hash ||
      (url.username && !url.password)
    )
      throw new Error();

    return {
      url: url.toString(),
      cluster: env.SHOPIFY_ADMISSION_CLUSTER === 'true',
    };
  } catch {
    throw new Error(
      'SHOPIFY_ADMISSION_URL must be a redis:// or rediss:// server URL without a database, query or fragment',
    );
  }
}

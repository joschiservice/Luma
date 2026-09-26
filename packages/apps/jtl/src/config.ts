import { isIP } from 'node:net';

export interface JtlEndpoint {
  tenantId: string;
  baseUrl: string;
  addresses: string[];
}

/** Reads and validates the deployment allowlist before any on-premise requests. */
export function readJtlEndpoints(
  env: Readonly<Record<string, string | undefined>>,
) {
  let endpoints: unknown;
  const invalidEndpoints = () =>
    new Error(
      'JTL_ALLOWED_ENDPOINTS must contain tenantId, an exact HTTPS baseUrl and approved IP addresses',
    );
  try {
    endpoints = JSON.parse(env.JTL_ALLOWED_ENDPOINTS ?? '[]');
  } catch {
    throw invalidEndpoints();
  }
  if (!Array.isArray(endpoints)) throw invalidEndpoints();
  const jtlEndpoints: JtlEndpoint[] = [];
  for (const entry of endpoints) {
    if (
      !entry ||
      typeof entry !== 'object' ||
      typeof entry.baseUrl !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        entry.tenantId ?? '',
      ) ||
      !Array.isArray(entry.addresses) ||
      !entry.addresses.length ||
      !entry.addresses.every(
        (ip: unknown) => typeof ip === 'string' && isIP(ip),
      )
    )
      throw invalidEndpoints();
    let url: URL;
    try {
      url = new URL(entry.baseUrl);
    } catch {
      throw invalidEndpoints();
    }
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !url.pathname.endsWith('/') ||
      url.href !== entry.baseUrl ||
      isIP(url.hostname.replace(/^\[|\]$/g, ''))
    )
      throw invalidEndpoints();
    if (
      jtlEndpoints.some(
        (e) => e.tenantId === entry.tenantId && e.baseUrl === entry.baseUrl,
      )
    )
      throw invalidEndpoints();
    jtlEndpoints.push({
      tenantId: entry.tenantId,
      baseUrl: url.href,
      addresses: [...entry.addresses],
    });
  }

  return jtlEndpoints;
}

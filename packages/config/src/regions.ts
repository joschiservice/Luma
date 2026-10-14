const dataRegions = ['EU', 'AU', 'US'] as const;

export type DataRegion = (typeof dataRegions)[number];

export interface RegionConfig {
  region: DataRegion;
  enabledRegions: DataRegion[];
}

/** Reads the cell's immutable jurisdiction and the regions accepting new accounts. */
export function readRegionConfig(
  env: Readonly<Record<string, string | undefined>>,
): RegionConfig {
  const region = env.LUMA_REGION ?? 'AU';
  const enabled = (
    env.LUMA_ENABLED_REGIONS ?? (env.NODE_ENV === 'production' ? 'AU' : region)
  )
    .split(',')
    .map((value) => value.trim());
  if (
    !isDataRegion(region) ||
    !enabled.length ||
    enabled.some((value) => !isDataRegion(value)) ||
    new Set(enabled).size !== enabled.length
  )
    throw new Error(
      'LUMA_REGION and LUMA_ENABLED_REGIONS must use EU, AU or US',
    );
  const enabledRegions = enabled.filter(isDataRegion);
  if (!enabledRegions.includes(region))
    throw new Error('LUMA_REGION must be enabled');

  return { region, enabledRegions };
}

/** Validates a jurisdiction without treating broad geographies as data regions. */
function isDataRegion(value: string): value is DataRegion {
  return dataRegions.some((region) => region === value);
}

export const regionalAwsRegions: Readonly<
  Record<DataRegion, readonly string[]>
> = {
  EU: [
    'eu-central-1',
    'eu-north-1',
    'eu-south-1',
    'eu-south-2',
    'eu-west-1',
    'eu-west-3',
  ],
  AU: ['ap-southeast-2', 'ap-southeast-4'],
  US: ['us-east-1', 'us-east-2', 'us-west-1', 'us-west-2'],
};

type RegionalService = 'temporal' | 'sentry' | 'langfuse' | 'posthog' | 'mail';

const services: readonly RegionalService[] = [
  'temporal',
  'sentry',
  'langfuse',
  'posthog',
  'mail',
];

/**
 * Enforces deployment-reviewed exact service origins. AU services are disabled unless an
 * operator supplies an inspected regional endpoint; no service inherits another cell's URL.
 */
export function assertRegionalServiceEndpoint(
  env: Readonly<Record<string, string | undefined>>,
  service: RegionalService,
  endpoint: string,
): void {
  const { region } = readRegionConfig(env);
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || url.password || url.search || url.hash)
    throw new Error('Regional services require HTTPS endpoints');
  if (
    region === 'AU' &&
    ((service === 'mail' && url.hostname === 'api.resend.com') ||
      (service === 'posthog' &&
        ['eu.i.posthog.com', 'us.i.posthog.com'].includes(url.hostname)) ||
      (service === 'langfuse' &&
        ['cloud.langfuse.com', 'us.cloud.langfuse.com'].includes(
          url.hostname,
        )) ||
      (service === 'sentry' && url.hostname.endsWith('.sentry.io')))
  )
    throw new Error(
      `The ${service} hosted endpoint is unavailable in Australia`,
    );
  let configured: unknown;
  try {
    configured = JSON.parse(env.LUMA_REGIONAL_SERVICE_ENDPOINTS ?? '{}');
  } catch {
    throw new Error(
      'LUMA_REGIONAL_SERVICE_ENDPOINTS must be a regional service allowlist',
    );
  }
  if (
    !configured ||
    typeof configured !== 'object' ||
    Array.isArray(configured)
  )
    throw new Error(
      'LUMA_REGIONAL_SERVICE_ENDPOINTS must be a regional service allowlist',
    );
  for (const [key, value] of Object.entries(configured)) {
    if (
      !isDataRegion(key) ||
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value)
    )
      throw new Error('Invalid regional service allowlist');
    for (const [name, origins] of Object.entries(value)) {
      if (
        !services.includes(name as RegionalService) ||
        !Array.isArray(origins) ||
        origins.some((origin: unknown) => {
          if (typeof origin !== 'string') return true;
          try {
            const parsed = new URL(origin);

            return (
              parsed.protocol !== 'https:' ||
              parsed.origin !== origin ||
              !!parsed.username ||
              !!parsed.password
            );
          } catch {
            return true;
          }
        })
      )
        throw new Error('Invalid regional service allowlist');
    }
  }
  const entries = configured as Partial<
    Record<DataRegion, Partial<Record<RegionalService, string[]>>>
  >;
  const allowed = entries[region]?.[service];
  if (allowed?.includes(url.origin)) return;
  if (allowed === undefined && region === 'EU') {
    if (
      service === 'sentry' &&
      /^o\d+\.ingest\.de\.sentry\.io$/.test(url.hostname) &&
      !url.port
    )
      return;
    if (service === 'langfuse' && url.origin === 'https://cloud.langfuse.com')
      return;
    if (service === 'posthog' && url.origin === 'https://eu.i.posthog.com')
      return;
  }
  throw new Error(`The ${service} endpoint is unavailable for the cell region`);
}

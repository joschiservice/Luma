import { staffConfigSchema } from '@luma/api-contract/staff';
import { z } from 'zod';

export const staffRegionSchema = z.enum(['AU', 'EU', 'US']);

export type StaffRegion = z.infer<typeof staffRegionSchema>;
let config: z.infer<typeof staffConfigSchema> | undefined;
let activeRegion: StaffRegion = 'AU';
let loading: Promise<void> | undefined;

/** Loads public regional routing once, before any private staff request. No customer directory is retained here. */
export async function initializeStaffRegions(region?: StaffRegion) {
  loading ??= fetch('/api/v1/staff/config', { cache: 'no-store' })
    .then(async (response) => {
      if (!response.ok)
        throw new Error('Regional staff configuration is unavailable.');
      config = staffConfigSchema.parse(await response.json());
      activeRegion = config.region;
    })
    .catch((error) => {
      loading = undefined;
      throw error;
    });
  await loading;
  const selected = region ?? config!.region;
  if (!staffRegions().includes(selected))
    throw new Error('This staff region is not configured.');
  activeRegion = selected;
}

/** Returns the region that owns all commands and private reads in the active route. */
export function staffRegion() {
  if (
    typeof window !== 'undefined' &&
    typeof window.location.href === 'string'
  ) {
    const selected = staffRegionSchema.safeParse(
      new URL(window.location.href).searchParams.get('region'),
    );

    return selected.success ? selected.data : (config?.region ?? activeRegion);
  }

  return activeRegion;
}

/** Lists every configured regional staff API, including the local cell. */
export function staffRegions(): StaffRegion[] {
  if (!config) return [activeRegion];

  return Array.from(
    new Set([
      config.region,
      ...Object.keys(config.regionalApiOrigins).map((region) =>
        staffRegionSchema.parse(region),
      ),
    ]),
  );
}

/** Builds a regional browser fetcher; API cookies stay scoped to their own hostname. */
export function regionalFetch(region: StaffRegion): typeof fetch {
  return (input, init) => {
    const origin = config?.regionalApiOrigins[region];
    if (!origin && config && region !== config.region)
      throw new Error('This staff region is unavailable.');
    if (!origin) return fetch(input, init);
    const path =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;

    return fetch(new URL(path.replace(/^\/api(?=\/)/, ''), origin), {
      ...init,
      credentials: 'include',
    });
  };
}

/** Preserves the selected cell when restarting independent regional staff sign-in. */
export function staffPath(path: string, region: StaffRegion = activeRegion) {
  const url = new URL(path, window.location.origin);
  url.searchParams.set('region', region);

  return url.pathname + url.search;
}

/** Keeps remote staff directory search behind the server-evaluated rollout flag. */
export function canSearchStaffRegion(
  region: StaffRegion,
  searchRegion = activeRegion,
) {
  return region === searchRegion || config?.regionalDirectoryEnabled === true;
}

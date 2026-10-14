import { z } from 'zod';

const origin = z.url().refine((value) => {
  const url = new URL(value);

  return ['http:', 'https:'].includes(url.protocol) && url.origin === value;
});

const placement = z.object({
  region: z.enum(['AU', 'EU', 'US']),
  globalEntryUrl: origin,
  regionalOrigins: z.partialRecord(z.enum(['AU', 'EU', 'US']), origin),
});

/**
 * Redirects the configured session-free entry origin to its cell before rendering or reading
 * cookies. Query strings are dropped so credentials and tenant links never enter the global path.
 */
export function globalEntryRedirect(
  request: Request,
  env: Readonly<Record<string, string | undefined>>,
): Response | undefined {
  if (!env.LUMA_GLOBAL_ENTRY_URL) return undefined;
  const settings = placement.parse({
    region: env.LUMA_REGION ?? 'AU',
    globalEntryUrl: env.LUMA_GLOBAL_ENTRY_URL,
    regionalOrigins: JSON.parse(env.LUMA_REGIONAL_ORIGINS ?? '{}'),
  });
  if (
    env.NODE_ENV === 'production' &&
    [settings.globalEntryUrl, ...Object.values(settings.regionalOrigins)].some(
      (value) => new URL(value).protocol !== 'https:',
    )
  )
    throw new Error('Production entry and regional origins require HTTPS.');
  const incoming = new URL(request.url);
  if (incoming.origin !== new URL(settings.globalEntryUrl).origin)
    return undefined;
  const cell = settings.regionalOrigins[settings.region];
  if (!cell || new URL(cell).origin === incoming.origin)
    throw new Error(
      'Global entry requires a distinct configured regional origin.',
    );

  return new Response(null, {
    status: 302,
    headers: {
      Location: new URL('/', cell).href,
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    },
  });
}

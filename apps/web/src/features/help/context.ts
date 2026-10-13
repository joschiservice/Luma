/**
 * Guides that workspace routes can open from Help, as slugs under `/docs`. Each must be an
 * existing English guide.
 */
export const helpTopics = [
  'needs-you',
  'inbox',
  'issues',
  'issues/investigate',
  'issues/resolve',
  'orders',
  'customers',
  'products',
  'inventory',
  'fulfillment',
  'returns',
  'procurement',
  'apps-and-connections',
  'data-sync',
  'activity',
  'records',
  'insights',
  'workflows',
  'workflows/create',
  'home',
  'saved-views',
  'workspace-settings',
  'roles-and-permissions',
  'account-security',
] as const;

export type HelpTopic = (typeof helpTopics)[number];

/**
 * A route's guide: a fixed topic, or one chosen from the route's path parameters when a single
 * route serves several pages, such as the settings sections.
 */
export type RouteHelp =
  HelpTopic | ((params: Record<string, string | undefined>) => HelpTopic);

declare module '@tanstack/react-router' {
  interface StaticDataRouteOption {
    help?: RouteHelp;
  }
}

/** Finds the most specific help topic among the active route matches. */
export function contextualTopic(
  matches: {
    staticData: { help?: RouteHelp };
    params?: Record<string, string | undefined>;
  }[],
) {
  for (let index = matches.length - 1; index >= 0; index--) {
    const match = matches[index];
    const help = match?.staticData.help;
    const topic = typeof help === 'function' ? help(match?.params ?? {}) : help;
    if (topic) return topic;
  }

  return undefined;
}

/** Reads a documentation link without accepting links to other origins or routes. */
export function docLocation(href: string) {
  const match = /^\/docs\/([^?#]+)(?:#(.*))?$/.exec(href);

  return match ? { slug: match[1]!, hash: match[2] ?? '' } : undefined;
}

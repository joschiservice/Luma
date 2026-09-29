export type HelpTopic =
  | 'issues'
  | 'issues/investigate'
  | 'issues/resolve'
  | 'orders'
  | 'workflows'
  | 'workflows/create';

declare module '@tanstack/react-router' {
  interface StaticDataRouteOption {
    help?: HelpTopic;
  }
}

/** Finds the most specific help topic among the active route matches. */
export function contextualTopic(
  matches: { staticData: { help?: HelpTopic } }[],
) {
  for (let index = matches.length - 1; index >= 0; index--) {
    const topic = matches[index]?.staticData.help;
    if (topic) return topic;
  }

  return undefined;
}

/** Reads a documentation link without accepting links to other origins or routes. */
export function docLocation(href: string) {
  const match = /^\/docs\/([^?#]+)(?:#(.*))?$/.exec(href);

  return match ? { slug: match[1]!, hash: match[2] ?? '' } : undefined;
}

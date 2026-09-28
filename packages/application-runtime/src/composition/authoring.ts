import type { ModelGatewayConfig } from '@luma/config';
import { authoringModelProfile } from '@luma/platform';

const needed =
  'Describing workflows needs an EU model route with zero data retention.';

/**
 * Decides whether workflow authoring may use the configured model routes. Descriptions contain
 * tenant data, so only a Bedrock route in the EU with zero data retention qualifies. Anything else
 * makes the feature unavailable, with a reason whoever runs the server can act on.
 */
export function authoringAvailability(
  settings: ModelGatewayConfig | undefined,
  gatewayInstalled: boolean,
): { available: boolean; reason: string | null } {
  const route = settings?.routes[authoringModelProfile];
  const reason =
    !settings || !gatewayInstalled
      ? `${needed} Model routes aren’t configured on this server.`
      : !route
        ? `${needed} Whoever runs this Luma server needs to configure the authoring route.`
        : route.adapter !== 'bedrock-eu'
          ? `${needed} The authoring route doesn’t process data in the EU. Whoever runs this Luma server needs to route it to Bedrock in the EU.`
          : !route.zeroDataRetention
            ? `${needed} The authoring route keeps data. Whoever runs this Luma server needs to turn on zero data retention.`
            : !settings.bedrock
              ? `${needed} Bedrock isn’t configured. Whoever runs this Luma server needs to add the Bedrock settings.`
              : null;

  return { available: reason === null, reason };
}

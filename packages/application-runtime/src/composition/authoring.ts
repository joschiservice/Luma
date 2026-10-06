import { assistantModelProfile } from '@luma/assistant/composition';
import type { ModelGatewayConfig } from '@luma/config';
import { authoringModelProfile } from '@luma/platform';
import { supplierExtractionProfile } from '@luma/procurement/composition';

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
  return euAvailability(
    settings,
    gatewayInstalled,
    authoringModelProfile,
    needed,
    'authoring',
  );
}

/**
 * Decides whether supplier messages may be read by a model. Messages contain tenant and
 * personal data, so the same EU zero-retention Bedrock requirement applies.
 */
export function supplierExtractionAvailability(
  settings: ModelGatewayConfig | undefined,
  gatewayInstalled: boolean,
) {
  return euAvailability(
    settings,
    gatewayInstalled,
    supplierExtractionProfile,
    'Reading supplier messages needs an EU model route with zero data retention.',
    'supplier-extraction',
  );
}

/**
 * Decides whether members can ask the workspace assistant. Questions and the records it reads
 * are tenant data, so the same EU zero-retention Bedrock requirement applies.
 */
export function assistantAvailability(
  settings: ModelGatewayConfig | undefined,
  gatewayInstalled: boolean,
) {
  return euAvailability(
    settings,
    gatewayInstalled,
    assistantModelProfile,
    'Asking Luma needs an EU model route with zero data retention.',
    'assistant',
  );
}

function euAvailability(
  settings: ModelGatewayConfig | undefined,
  gatewayInstalled: boolean,
  profile: string,
  needed: string,
  name: string,
): { available: boolean; reason: string | null } {
  const route = settings?.routes[profile];
  const reason =
    !settings || !gatewayInstalled
      ? `${needed} Model routes aren’t configured on this server.`
      : !route
        ? `${needed} Whoever runs this Luma server needs to configure the ${name} route.`
        : route.adapter !== 'bedrock-eu'
          ? `${needed} The ${name} route doesn’t process data in the EU. Whoever runs this Luma server needs to route it to Bedrock in the EU.`
          : !route.zeroDataRetention
            ? `${needed} The ${name} route keeps data. Whoever runs this Luma server needs to turn on zero data retention.`
            : !settings.bedrock
              ? `${needed} Bedrock isn’t configured. Whoever runs this Luma server needs to add the Bedrock settings.`
              : null;

  return { available: reason === null, reason };
}

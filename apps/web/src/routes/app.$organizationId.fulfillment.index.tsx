import { createFileRoute } from '@tanstack/react-router';

import { fulfillmentSearch } from '../features/fulfillment/data';
import { FulfillmentPage } from '../features/fulfillment/page';

export const Route = createFileRoute('/app/$organizationId/fulfillment/')({
  validateSearch: fulfillmentSearch,
  staticData: { help: 'fulfillment' },
  component: FulfillmentPage,
});

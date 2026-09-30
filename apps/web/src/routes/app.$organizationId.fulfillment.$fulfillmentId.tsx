import { createFileRoute } from '@tanstack/react-router';

import { fulfillmentSearch } from '../features/fulfillment/data';
import { FulfillmentDetailPage } from '../features/fulfillment/detail';

export const Route = createFileRoute(
  '/app/$organizationId/fulfillment/$fulfillmentId',
)({
  validateSearch: fulfillmentSearch,
  staticData: { help: 'fulfillment' },
  component: FulfillmentDetailPage,
});

import { expect, it } from 'vitest';

import { activityLabel, activityState } from './presentation';

it('reads activity codes as sentences', () => {
  expect(activityLabel('provider_accepted')).toBe('Provider accepted');
  expect(activityLabel('orders.shipping-method.write')).toBe(
    'Order shipping method updated',
  );
  expect(activityLabel('purchase_order.created')).toBe(
    'Purchase order created',
  );
});

it('treats only verified outcomes as confirmed results', () => {
  expect(activityState('verified')).toBe('verified');
  expect(activityState('provider_accepted')).toBe('running');
  expect(activityState('failed')).toBe('error');
});

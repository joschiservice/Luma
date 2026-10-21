import { it } from 'vitest';

import { reviewedPurchasingCycle } from './purchasing-cycle-journey.mjs';

it(
  'runs a reviewed purchasing cycle with changed commitments and damaged partial receipt through jtl',
  (t) => reviewedPurchasingCycle(t, 'jtl'),
  120_000,
);

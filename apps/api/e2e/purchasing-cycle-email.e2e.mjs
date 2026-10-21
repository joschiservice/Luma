import { it } from 'vitest';

import { reviewedPurchasingCycle } from './purchasing-cycle-journey.mjs';

it(
  'runs a reviewed purchasing cycle with changed commitments and damaged partial receipt through email',
  (t) => reviewedPurchasingCycle(t, 'email'),
  120_000,
);

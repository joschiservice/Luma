import { createObservability } from '@luma/platform/composition';
import { expect, it } from 'vitest';

import { createTenantFeatureRelease } from './feature-release.js';

it('withholds shipping releases without telemetry or an explicit synthetic override', async () => {
  const tenantId = '33333333-3333-4333-8333-333333333333';
  expect(
    await createTenantFeatureRelease()(tenantId, 'starshipit-actions'),
  ).toBe(false);
  const observability = createObservability({
    environment: 'test',
    release: 'test',
    sampleRate: 0,
    featureFlagOverrides: { 'starshipit-fulfillment': true },
  });
  try {
    const enabled = createTenantFeatureRelease(observability);
    expect(await enabled(tenantId, 'starshipit-fulfillment')).toBe(true);
    expect(await enabled(tenantId, 'starshipit-actions')).toBe(false);
    expect(await enabled(tenantId, 'shopify-shipment-publishing')).toBe(false);
  } finally {
    await observability.shutdown();
  }
});

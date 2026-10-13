import { randomUUID } from 'node:crypto';

import { createObservability } from '@luma/platform/composition';
import { expect, it } from 'vitest';

import {
  correctionFixture,
  stockItem,
  stockLocation,
} from './shopify-inventory-fixture.mjs';

it('projects the exact owner-bound change into Needs you and rejects a changed baseline before any effect', async (t) => {
  const observability = createObservability({
    environment: 'test',
    release: 'test',
    sampleRate: 0,
    featureFlagOverrides: { 'action-review-diffs': true },
  });
  const { f, admin, call, target, mutations, changeAvailable } =
    await correctionFixture(t, 'http://localhost:3000', { observability });
  const preview = await call(f.owner, 'preview', {
    ...target,
    requestId: randomUUID(),
  });
  const queue = await f.request(admin, `${f.base}/decisions?domain=inventory`);
  const item = queue.items.find((item) => item.kind === 'inventory_correction');
  expect(item.diff).toMatchObject({
    reversibility: 'compensatable',
    canonicalOutcome: 'requires_fresh_verification',
    policy: { outcome: 'approval_required', current: false },
  });
  expect(item.diff.records[0]).toMatchObject({
    system: 'provider',
    connectionId: target.connectionId,
    kind: 'inventory_item',
    id: stockItem,
  });
  expect(
    item.diff.records[0].changes.find((change) => change.field === 'available'),
  ).toMatchObject({
    before: 12,
    after: 9,
    expected: 12,
    beforeKnown: true,
    afterKnown: true,
    expectedKnown: true,
  });
  expect(
    item.diff.records.find((record) => record.system === 'luma'),
  ).toMatchObject({
    kind: 'position',
    id: target.positionId,
    link: `/app/${f.org.id}/inventory/${target.positionId}`,
  });
  expect(item.diff.scope).toContainEqual({
    kind: 'location',
    count: 1,
    ids: [stockLocation],
  });
  expect(item.diff.evidence.observedAt).toBe(
    [preview.before.observedAt, preview.before.source.observedAt].sort()[0],
  );
  expect(item.diff.evidence.ageSeconds).toBeGreaterThanOrEqual(0);
  expect(item).not.toHaveProperty('actionReference');
  expect(
    (
      await f.request(f.member, `${f.base}/decisions?domain=inventory`)
    ).items.find((item) => item.kind === 'inventory_correction'),
  ).toBeUndefined();
  await f.request(f.outsider, `${f.base}/decisions`, 'GET', undefined, 404);
  await changeAvailable(11);
  await call(admin, 'approve', { id: preview.id, outcome: 'approved' }, 409);
  expect(mutations).toHaveLength(0);
  const retained = (
    await f.request(admin, `${f.base}/decisions?domain=inventory`)
  ).items.find((item) => item.kind === 'inventory_correction');
  if (retained)
    expect(
      retained.diff.records[0].changes.find(
        (change) => change.field === 'available',
      ).before,
    ).toBe(12);
});

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { test, vi } from 'vitest';

import { starshipitUpdatesFixture } from './starshipit-updates-fixture.mjs';

// Three previews, approvals and fresh reads run in sequence, so this journey needs more than the default.
test('labels, changed authority, and cancelled authoritative orders withhold approved shipping corrections', async (t) => {
  const f = await starshipitUpdatesFixture(t),
    preview = await f.preview();
  await f.call(
    'approve',
    { id: preview.id, outcome: 'approved' },
    { cookie: f.approver },
  );
  await f.command('starshipit', {
    kind: 'status',
    order: '1',
    status: 'Printed',
  });
  await f.call('execute', { id: preview.id }, { status: 409 });
  assert.equal((await f.receipts()).length, 0);
  await f.call('check', { id: preview.id });
  await f.command('starshipit', {
    kind: 'status',
    order: '1',
    status: 'Unshipped',
  });
  await f.pilot.observe({ check: false });
  const next = await f.preview();
  await f.call(
    'approve',
    { id: next.id, outcome: 'approved' },
    { cookie: f.approver },
  );
  const authority = await f.api('/source-authority');
  await f.api('/source-authority', {
    method: 'POST',
    body: {
      commandId: randomUUID(),
      revision: authority.revision,
      group: 'order_lines',
      connectionId: f.manifest.connections.jtl,
    },
  });
  await f.call('execute', { id: next.id }, { status: 409 });
  assert.equal((await f.receipts()).length, 0);
  await f.call('check', { id: next.id });
  const current = await f.api('/source-authority');
  await f.api('/source-authority', {
    method: 'POST',
    body: {
      commandId: randomUUID(),
      revision: current.revision,
      group: 'order_lines',
      connectionId: f.manifest.connections.shopify,
    },
  });
  const expired = await f.preview();
  await f.call(
    'approve',
    { id: expired.id, outcome: 'approved' },
    { cookie: f.approver },
  );
  const clock = vi
    .spyOn(Date, 'now')
    .mockReturnValue(Date.parse(expired.expiresAt) + 1);
  try {
    await f.call('execute', { id: expired.id }, { status: 409 });
    await f.call('check', { id: expired.id });
  } finally {
    clock.mockRestore();
  }
  assert.equal((await f.receipts()).length, 0);
  await f.command('shopify', {
    kind: 'cancel',
    order: '1',
    reason: 'CUSTOMER',
  });
  await f.pilot.observe({ check: false });
  await f.preview({ status: 409 });
  assert.equal((await f.receipts()).length, 0);
}, 120_000);

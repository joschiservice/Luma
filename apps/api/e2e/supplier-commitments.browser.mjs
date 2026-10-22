/* global document, window, MouseEvent */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { createObservability } from '@luma/platform/composition';

import { expect, test } from './browser-fixtures.mjs';
import { until } from './helpers.mjs';
import { setupSimulator } from './simulator-fixture.mjs';

test('sends an order with a second approver, follows the supplier to receipt and records cited commitments', async ({
  resources: t,
  web,
}) => {
  const origin = web.origin;
  const f = await setupSimulator(t, { origin });
  await f.pilot.observe();
  await web.route(f.apiOrigin);
  const org = f.manifest.organizationId;
  const login = async (email) => {
    const response = await f.pilot.app.inject({
      method: 'POST',
      url: '/auth/sign-in/email',
      headers: { origin },
      payload: { email, password: f.password },
    });
    assert.equal(response.statusCode, 200, response.body);

    return []
      .concat(response.headers['set-cookie'])
      .map((v) => v.split(';')[0])
      .join('; ');
  };
  const buyerCookie = await login('pilot-operator@example.test');
  const approverCookie = await login('pilot-requester@example.test');
  const call = async (path, body) => {
    const response = await f.pilot.app.inject({
      method: body ? 'POST' : 'GET',
      url: `/v1/organizations/${org}/procurement${path}`,
      headers: { cookie: buyerCookie, origin },
      ...(body ? { payload: body } : {}),
    });
    assert.equal(response.statusCode, 200, response.body);

    return response.json();
  };
  const simulator = (command) =>
    f.call('runs/operations/control', {
      action: 'command',
      instance: 'jtl',
      command,
    });
  await simulator({
    kind: 'supplier-profile',
    supplierId: '1',
    profile: 'silent',
  });
  const supplier = await call('/suppliers', {
    id: randomUUID(),
    name: 'Nordwind Textil',
    externalReferences: [],
  });
  await call(`/suppliers/${supplier.id}/link`, {
    expectedRevision: 1,
    link: {
      connectionId: f.manifest.connections.jtl,
      externalId: '1',
      scopeKey: '',
    },
    confirmationHours: 48,
  });
  const sku = (
    await f.db.owner.query(
      `SELECT canonical_id FROM connector_source_mappings WHERE tenant_id=$1 AND connection_id=$2
       AND resource='sku' AND external_id='2'`,
      [org, f.manifest.connections.jtl],
    )
  ).rows[0].canonical_id;
  const order = await call('/purchase-orders', {
    id: randomUUID(),
    supplierId: supplier.id,
    reference: 'PO-2026-201',
    lines: [
      {
        id: randomUUID(),
        sku,
        description: 'Canvas tote',
        quantity: 50,
        unit: 'each',
      },
    ],
  });

  const contextFor = async (cookie, options = {}) => {
    const context = await t.newContext({
      baseURL: origin,
      viewport: { width: 1440, height: 1000 },
      ...options,
    });
    await context.addCookies(
      cookie.split('; ').map((value) => {
        const [name, ...rest] = value.split('=');

        return { name, value: rest.join('='), url: origin };
      }),
    );

    return context;
  };
  const buyer = await (await contextFor(buyerCookie)).newPage();
  buyer.setDefaultTimeout(20000);
  const errors = [];
  buyer.on('pageerror', (error) => errors.push(error.message));
  const orderPath = `/app/${org}/procurement/${order.id}`;
  await buyer.goto(orderPath);
  await buyer
    .getByRole('heading', { name: 'PO-2026-201', exact: true })
    .waitFor();
  await buyer.getByText('Draft, not sent').waitFor();

  // A committed request whose response is lost keeps its body; retry returns the same submission.
  await buyer
    .getByRole('button', { name: 'Send to supplier', exact: true })
    .click();
  await buyer.route(
    '**/procurement/purchase-orders/*/submissions',
    async (route) => {
      await route.fetch();
      await route.abort('failed');
    },
    { times: 1 },
  );
  await buyer
    .getByRole('dialog')
    .getByRole('button', { name: 'Request approval' })
    .click();
  await buyer.getByRole('button', { name: 'Retry', exact: true }).click();
  await buyer.getByRole('dialog').waitFor({ state: 'hidden' });
  await buyer.getByText('Waiting for approval').first().waitFor();
  expect(
    (await call(`/purchase-orders/${order.id}/record`)).submissions,
  ).toHaveLength(1);
  await buyer
    .getByText('Waiting for someone else who can approve changes')
    .waitFor();

  // The second admin approves from Needs you; Luma places the order once as the requester.
  const approver = await (await contextFor(approverCookie)).newPage();
  approver.setDefaultTimeout(20000);
  approver.on('pageerror', (error) => errors.push(error.message));
  await approver.goto(`/app/${org}/needs-you`);
  await approver
    .getByText('Approve sending PO-2026-201 to Nordwind Textil')
    .first()
    .click();
  await approver.getByRole('button', { name: 'Approve and send' }).click();
  await until(
    async () =>
      (await call(`/purchase-orders/${order.id}/record`)).stage ===
      'awaiting_confirmation',
    'order sent',
    20000,
  );
  const placed = (
    await f.call('runs/operations/records/jtl?kind=purchase-order&limit=100')
  ).items
    .map((item) => item.data)
    .filter((o) => String(o.internalComment ?? '').includes(order.id));
  expect(placed).toHaveLength(1);

  // The supplier confirms fewer units in JTL; the buyer accepts the change.
  const externalId = String(placed[0].purchaseOrderId);
  const lineItemId = String(Number(externalId) * 1000 + 1);
  await simulator({
    kind: 'purchase-order-confirm',
    orderId: externalId,
    lines: [
      {
        lineItemId,
        quantity: 30,
        deliveryDate: (await call(`/purchase-orders/${order.id}/record`))
          .submission.requestedDeliveryDate,
      },
    ],
  });
  await f.pilot.followUp();
  await buyer.reload();
  await buyer.getByText('Confirmed with changes').first().waitFor();
  await buyer
    .getByRole('button', { name: 'Accept or follow up' })
    .first()
    .click();
  await buyer.getByLabel('Note').fill('Partial delivery is fine this week');
  await buyer
    .getByRole('dialog')
    .getByRole('button', { name: 'Accept change' })
    .click();
  await buyer.getByRole('dialog').waitFor({ state: 'hidden' });
  await buyer.getByText('Waiting for goods receipt').waitFor();

  // A supplier message is recorded once; selected words become a cited commitment.
  await buyer.getByRole('button', { name: 'Add message' }).click();
  await buyer.getByLabel('From').fill('orders@nordwind-textil.example');
  await buyer.getByLabel('Subject').fill('Re: PO-2026-201');
  await buyer
    .getByLabel('Message', { exact: true })
    .fill(
      'Thanks for your order. The goods leave our warehouse on 2026-10-09.',
    );
  await buyer
    .getByRole('dialog')
    .getByRole('button', { name: 'Add message' })
    .click();
  await buyer.getByRole('dialog').waitFor({ state: 'hidden' });
  const text = buyer.getByLabel('Message from orders@nordwind-textil.example');
  await text.waitFor();
  await text.evaluate((node) => {
    const walker = document.createTreeWalker(node, 4);
    let current = walker.nextNode();
    while (current && !current.textContent.includes('leave our warehouse'))
      current = walker.nextNode();
    const start = current.textContent.indexOf('leave our warehouse');
    const range = document.createRange();
    range.setStart(current, start);
    range.setEnd(current, start + 'leave our warehouse on 2026-10-09'.length);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);
    node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await buyer.getByRole('button', { name: 'Record what this says' }).click();
  await buyer.getByRole('combobox', { name: 'What it states' }).click();
  await buyer.getByRole('option', { name: 'Shipped' }).click();
  await buyer.getByLabel('Shipped on').fill('2026-10-09');
  await buyer
    .getByRole('dialog')
    .getByRole('button', { name: 'Record commitment' })
    .click();
  await buyer.getByRole('dialog').waitFor({ state: 'hidden' });
  await buyer.getByText('Shipped: 9 Oct 2026').first().waitFor();
  const record = await call(`/purchase-orders/${order.id}/record`);
  expect(
    record.commitments.find((c) => c.kind === 'shipped')?.source,
  ).toMatchObject({
    kind: 'communication',
    extraction: null,
  });
  // Being told about a shipment is not receipt.
  expect(record.stage).not.toBe('received');

  // Receipt only counts once JTL books it.
  await simulator({
    kind: 'purchase-order-receive',
    orderId: externalId,
    lines: [{ lineItemId, quantity: 30 }],
  });
  await f.pilot.followUp();
  await buyer.getByRole('button', { name: 'Refresh', exact: true }).click();
  await buyer.getByText('Close the order').first().waitFor();
  await buyer.getByText('Received', { exact: true }).first().waitFor();

  await buyer
    .getByRole('link', { name: 'Nordwind Textil', exact: true })
    .first()
    .click();
  await buyer
    .getByRole('heading', { name: 'Nordwind Textil', exact: true })
    .waitFor();
  await buyer.getByText('Purchasing link active').waitFor();
  await buyer.getByRole('link', { name: 'PO-2026-201', exact: true }).waitFor();

  const narrow = await (
    await contextFor(buyerCookie, {
      viewport: { width: 390, height: 844 },
      colorScheme: 'dark',
    })
  ).newPage();
  await narrow.goto(orderPath);
  await narrow
    .getByRole('heading', { name: 'PO-2026-201', exact: true })
    .waitFor();
  expect(
    await narrow.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
});

test('settles an order email left uncertain by an unverified bounce with a confirmed decision', async ({
  resources: t,
  web,
}) => {
  const origin = web.origin;
  const flags = { 'procurement-email-submission': true };
  const f = await setupSimulator(t, {
    origin,
    featureFlagOverrides: flags,
    observability: createObservability({
      environment: 'test',
      release: 'test',
      sampleRate: 0,
      featureFlagOverrides: flags,
    }),
  });
  await f.pilot.observe();
  await web.route(f.apiOrigin);
  const org = f.manifest.organizationId;
  const login = async (email) => {
    const response = await f.pilot.app.inject({
      method: 'POST',
      url: '/auth/sign-in/email',
      headers: { origin },
      payload: { email, password: f.password },
    });
    assert.equal(response.statusCode, 200, response.body);

    return []
      .concat(response.headers['set-cookie'])
      .map((v) => v.split(';')[0])
      .join('; ');
  };
  const buyerCookie = await login('pilot-operator@example.test');
  const approverCookie = await login('pilot-requester@example.test');
  const api = async (path, body, cookie = buyerCookie) => {
    const response = await f.pilot.app.inject({
      method: body ? 'POST' : 'GET',
      url: `/v1/organizations/${org}${path}`,
      headers: { cookie, origin },
      ...(body ? { payload: body } : {}),
    });
    assert.equal(response.statusCode, 200, `${path}: ${response.body}`);

    return response.json();
  };
  const supplier = await api('/procurement/suppliers', {
    id: randomUUID(),
    name: 'Kontor Papier',
    email: 'orders@kontor-papier.example',
    language: 'en',
    externalReferences: [],
  });
  const sku = (
    await f.db.owner.query(
      `SELECT canonical_id FROM connector_source_mappings WHERE tenant_id=$1 AND connection_id=$2
       AND resource='sku' AND external_id='2'`,
      [org, f.manifest.connections.jtl],
    )
  ).rows[0].canonical_id;
  const order = await api('/procurement/purchase-orders', {
    id: randomUUID(),
    supplierId: supplier.id,
    reference: 'PO-2026-301',
    lines: [
      {
        id: randomUUID(),
        sku,
        description: 'Canvas tote',
        quantity: 20,
        unit: 'each',
      },
    ],
  });

  // The order email is approved by a second person and verified as sent by the mailbox.
  await api('/messaging/mailboxes');
  const draft = await api(
    `/procurement/purchase-orders/${order.id}/email/submission`,
    {
      id: randomUUID(),
      connectionId: f.manifest.connections.gmail,
      requestedDeliveryDate: new Date(Date.now() + 7 * 86_400_000)
        .toISOString()
        .slice(0, 10),
      company: {
        name: 'Luma Goods GmbH',
        address: 'Hauptstraße 1\n10115 Berlin',
        registration: null,
      },
    },
  );
  const requested = await api(`/messaging/outbound/${draft.id}/request`, {
    id: randomUUID(),
  });
  const sent = await api(
    `/messaging/outbound/${draft.id}/decision`,
    { decisionId: requested.decisionId, outcome: 'approved' },
    approverCookie,
  );
  expect(sent.state).toBe('sent');

  // A bounce whose sender Gmail could not authenticate leaves delivery uncertain.
  await f.call('runs/operations/control', {
    action: 'command',
    instance: 'gmail',
    command: {
      kind: 'bounce',
      message: `luma.${draft.id}@luma-goods.example`,
      recipient: supplier.email,
      status: '5.1.1',
      authentication: 'fail',
    },
  });
  await until(
    async () => {
      // Bounces match no mailbox rule; the supplier mail pass rereads the send's thread.
      await f.db.owner.query(
        `UPDATE messaging_outbound SET document=jsonb_set(document,'{deliveryCheckedAt}','"2026-01-01T00:00:00Z"')
         WHERE tenant_id=$1 AND id=$2`,
        [org, draft.id],
      );
      await api(
        `/messaging/mailboxes/${f.manifest.connections.gmail}/sync`,
        {},
      );
      await f.pilot.messaging.sync({ passes: 5 });
      const record = await api(
        `/procurement/purchase-orders/${order.id}/record`,
      );

      return record.submission?.state === 'uncertain';
    },
    'the unverified bounce makes the order email uncertain',
    30_000,
  );

  const context = await t.newContext({
    baseURL: origin,
    viewport: { width: 1440, height: 1000 },
  });
  await context.addCookies(
    buyerCookie.split('; ').map((value) => {
      const [name, ...rest] = value.split('=');

      return { name, value: rest.join('='), url: origin };
    }),
  );
  const buyer = await context.newPage();
  buyer.setDefaultTimeout(20000);
  const errors = [];
  buyer.on('pageerror', (error) => errors.push(error.message));
  await buyer.goto(`/app/${org}/procurement/${order.id}`);
  const panel = buyer.getByRole('region', { name: 'Supplier email' });
  await panel.getByText('Recipient in the report').waitFor();
  await expect(panel.getByText(supplier.email).first()).toBeVisible();
  await expect(panel.getByText('5.1.1').first()).toBeVisible();
  await expect(
    panel.getByRole('button', { name: 'Draft order email' }),
  ).toHaveCount(0);

  // Cancel leaves it unchanged; a lost response is retried with the same request.
  const actions = panel.getByRole('group', { name: 'Delivery decision' });
  await actions.getByRole('button', { name: 'Mark as not delivered' }).click();
  let dialog = buyer.getByRole('dialog');
  await expect(
    dialog.getByRole('heading', { name: 'Mark this email as not delivered?' }),
  ).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await dialog.waitFor({ state: 'hidden' });
  await actions.getByRole('button', { name: 'Mark as not delivered' }).click();
  dialog = buyer.getByRole('dialog');
  await dialog
    .getByLabel('Note (optional)')
    .fill('Called Kontor Papier; the order never arrived.');
  await buyer.route(
    '**/messaging/outbound/*/delivery',
    async (route) => {
      await route.fetch();
      await route.abort('failed');
    },
    { times: 1 },
  );
  await dialog.getByRole('button', { name: 'Mark as not delivered' }).click();
  await dialog.getByRole('alert').waitFor();
  await dialog.getByRole('button', { name: 'Retry', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });

  await expect(panel.getByText(/Marked as not delivered by You/)).toBeVisible();
  await expect(
    panel.getByText('Note: Called Kontor Papier; the order never arrived.'),
  ).toBeVisible();
  // Not delivered lets the buyer draft the order email again.
  await expect(
    panel.getByRole('button', { name: 'Draft order email' }),
  ).toBeEnabled();
  const record = await api(`/procurement/purchase-orders/${order.id}/record`);
  expect(record.submission).toMatchObject({
    channel: 'email',
    state: 'failed',
  });

  const narrow = await (
    await t.newContext({
      baseURL: origin,
      viewport: { width: 390, height: 844 },
      colorScheme: 'dark',
    })
  ).newPage();
  await narrow.context().addCookies(
    buyerCookie.split('; ').map((value) => {
      const [name, ...rest] = value.split('=');

      return { name, value: rest.join('='), url: origin };
    }),
  );
  await narrow.goto(`/app/${org}/procurement/${order.id}`);
  await narrow
    .getByRole('region', { name: 'Supplier email' })
    .getByText(/Marked as not delivered by You/)
    .waitFor();
  expect(
    await narrow.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
});

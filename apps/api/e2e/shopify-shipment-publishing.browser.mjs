/* global document */
import { expect, test } from './browser-fixtures.mjs';
import { availablePort, startProcess } from './helpers.mjs';
import { shipmentPublishingFixture } from './shopify-shipment-publishing-fixture.mjs';

test('publishes an exact downstream parcel from the shared fulfillment view with independent approval, then reviews a tracking correction and customer notification choice', async ({
  resources: t,
}) => {
  // Two independent approval/publication cycles include provider rereads under parallel journeys.
  test.setTimeout(180_000);
  const port = await availablePort(),
    origin = `http://127.0.0.1:${port}`;
  const f = await shipmentPublishingFixture(t, { origin });
  const source = await f.dispatch('BROWSER-PARCEL-1', 1);
  const canonicalOrder = (
    await f.db.owner.query(
      "SELECT canonical_id FROM connector_source_mappings WHERE tenant_id=$1 AND connection_id=$2 AND resource='order' AND external_id=$3",
      [f.manifest.organizationId, f.target.connectionId, f.target.orderId],
    )
  ).rows[0].canonical_id;
  const list = await f.api('/fulfillment?view=all');
  const work = list.items.find(
    (item) =>
      item.connectionId === f.target.connectionId &&
      item.order.id === canonicalOrder &&
      item.kind === 'fulfillment_order' &&
      item.externalId.startsWith('gid://shopify/FulfillmentOrder/'),
  );
  expect(work).toBeTruthy();
  const route = `/app/${f.manifest.organizationId}/fulfillment/${work.id}`;
  const web = startProcess(
    t,
    'e2e/web-server.mjs',
    { TEST_API_ORIGIN: f.apiOrigin, TEST_WEB_PORT: String(port) },
    true,
  );
  await web.message('listening');
  const errors = [];
  const pageFor = async (cookie) => {
    const context = await t.newContext({
      baseURL: origin,
      viewport: { width: 1280, height: 900 },
    });
    await context.addCookies(
      cookie.split('; ').map((value) => {
        const [name, ...rest] = value.split('=');

        return { name, value: rest.join('='), url: origin };
      }),
    );
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));

    return page;
  };
  const page = await pageFor(f.owner);
  await page.goto(route);
  const panel = page.locator('.shopify-recovery').filter({
    has: page.getByRole('heading', {
      name: 'Publish shipment to Shopify',
      exact: true,
    }),
  });
  await expect(
    panel.getByRole('heading', {
      name: 'Publish shipment to Shopify',
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    panel.getByRole('combobox', { name: 'Dispatched parcel', exact: true }),
  ).toContainText('BROWSER-PARCEL-1');
  await panel
    .getByRole('combobox', { name: 'Dispatched parcel', exact: true })
    .click();
  await page
    .getByRole('option')
    .filter({ hasText: 'BROWSER-PARCEL-1' })
    .click();
  const quantity = panel.getByRole('spinbutton').first();
  await quantity.fill('1');
  const confirmation = panel.getByRole('switch', {
    name: 'I confirm these exact items, quantities and warehouse belong to this dispatched parcel.',
    exact: true,
  });
  const notification = panel.getByRole('switch', {
    name: 'Notify the customer about this shipment or tracking update',
    exact: true,
  });
  await expect(notification).not.toBeChecked();
  await confirmation.check();
  await expect(
    panel.getByRole('button', { name: 'Save exact preview', exact: true }),
  ).toBeEnabled();
  const previewResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith('/shipment-publishing-preview') &&
      response.request().method() === 'POST',
  );
  await panel
    .getByRole('button', { name: 'Save exact preview', exact: true })
    .focus();
  await page.keyboard.press('Enter');
  const preview = await (await previewResponse).json();
  expect(preview.choice).toMatchObject({
    capability: 'fulfillment.shipment.create',
    source,
    allocationSource: 'operator',
    notifyCustomer: false,
    allocations: [{ quantity: 1 }],
  });
  await expect(
    panel.getByText('Customer notification: do not send', { exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByRole('button', {
      name: 'Publish approved shipment',
      exact: true,
    }),
  ).toHaveCount(0);
  const approver = await pageFor(f.approver);
  await approver.goto(route);
  const approval = approver.locator('.shopify-recovery').filter({
    has: approver.getByRole('heading', {
      name: 'Publish shipment to Shopify',
      exact: true,
    }),
  });
  const approvalResponse = approver.waitForResponse(
    (response) =>
      response.url().endsWith('/shipment-publishing-approve') &&
      response.request().method() === 'POST',
  );
  await approval
    .getByRole('button', { name: 'Approve this shipment', exact: true })
    .click();
  expect((await (await approvalResponse).json()).approved).toBe(true);
  await panel
    .getByRole('button', { name: 'Refresh shipping evidence', exact: true })
    .click();
  const publicationResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith('/shipment-publishing-execute') &&
      response.request().method() === 'POST',
    { timeout: 45_000 },
  );
  await panel
    .getByRole('button', { name: 'Publish approved shipment', exact: true })
    .click();
  expect((await (await publicationResponse).json()).state).toBe('verified');
  await expect(
    panel.getByText(
      'A fresh Shopify read verified the exact allocation and tracking.',
      { exact: true },
    ),
  ).toBeVisible();
  const published = await f.call('inspect', { ...f.target, source });
  expect(published.snapshot.shipments).toHaveLength(1);
  expect(published.snapshot.shipments[0].lines).toEqual(
    preview.choice.allocations.map((line) => ({
      orderLineId: line.orderLineId,
      quantity: line.quantity,
    })),
  );
  const correctedUrl = 'https://tracking.example.test/corrected-browser-parcel';
  await f.command('starshipit', {
    kind: 'tracking',
    order: '1',
    package: 1,
    status: 'Delivered',
    at: new Date().toISOString(),
    tracking_url: correctedUrl,
  });
  await f.pilot.observe({ check: false });
  await panel
    .getByRole('button', { name: 'Refresh shipping evidence', exact: true })
    .click();
  await panel
    .getByRole('button', { name: 'Review another shipment', exact: true })
    .click();
  await panel
    .getByRole('combobox', { name: 'Shopify change', exact: true })
    .click();
  await page
    .getByRole('option', { name: 'Update existing tracking', exact: true })
    .click();
  await expect(
    panel.getByRole('combobox', {
      name: 'Existing Shopify shipment',
      exact: true,
    }),
  ).toContainText('BROWSER-PARCEL-1');
  await notification.check();
  await confirmation.check();
  const trackingResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith('/shipment-publishing-preview') &&
      response.request().method() === 'POST',
  );
  await panel
    .getByRole('button', { name: 'Save exact preview', exact: true })
    .click();
  const tracking = await (await trackingResponse).json();
  expect(tracking.choice).toMatchObject({
    capability: 'fulfillment.tracking.update',
    notifyCustomer: true,
    fulfillmentId: published.snapshot.shipments[0].id,
  });
  await expect(
    panel.getByText('Customer notification: send', { exact: true }),
  ).toBeVisible();
  await approver.reload();
  const trackingApproval = approver.waitForResponse(
    (response) =>
      response.url().endsWith('/shipment-publishing-approve') &&
      response.request().method() === 'POST',
  );
  await approval
    .getByRole('button', { name: 'Approve this shipment', exact: true })
    .click();
  expect((await (await trackingApproval).json()).approved).toBe(true);
  await panel
    .getByRole('button', { name: 'Refresh shipping evidence', exact: true })
    .click();
  const trackingPublicationResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith('/shipment-publishing-execute') &&
      response.request().method() === 'POST',
    { timeout: 45_000 },
  );
  await panel
    .getByRole('button', { name: 'Publish approved shipment', exact: true })
    .click();
  expect((await (await trackingPublicationResponse).json()).state).toBe(
    'verified',
  );
  await expect(
    panel.getByText(
      'A fresh Shopify read verified the exact allocation and tracking.',
      { exact: true },
    ),
  ).toBeVisible();
  const verified = await f.call('inspect', { ...f.target, source });
  expect(verified.snapshot.shipments).toHaveLength(1);
  expect(verified.snapshot.shipments[0].tracking[0].url).toBe(correctedUrl);
  await panel.screenshot({ path: '/tmp/luma-shopify-publication-desktop.png' });
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await page.setViewportSize({ width: 390, height: 844 });
  await panel.scrollIntoViewIfNeeded();
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true);
  await panel.screenshot({
    path: '/tmp/luma-shopify-publication-mobile-dark.png',
  });
  const member = await pageFor(f.member);
  await member.goto(route);
  await expect(
    member.getByRole('heading', {
      name: 'Publish shipment to Shopify',
      exact: true,
    }),
  ).toHaveCount(0);
  expect(errors).toEqual([]);
});

/* global document, window */
import { expect, test } from './browser-fixtures.mjs';
import { fulfillmentFixture } from './fulfillment-fixture.mjs';
import { availablePort, startProcess } from './helpers.mjs';
import { settingsFixture } from './settings-fixture.mjs';

test('opens the exact records behind a chart point and returns to them', async ({
  resources: t,
}) => {
  const port = await availablePort(),
    origin = `http://127.0.0.1:${port}`;
  const f = await settingsFixture(t, origin);
  const work = await fulfillmentFixture(t, f);
  await work.issue();
  // Placed in the previous 7-day stretch, so the comparison has a record to open.
  const earlier = new Date(Date.now() - 9 * 24 * 3_600_000).toISOString();
  await work.order({
    external: 'order-405',
    key: 'order-405',
    updatedAt: earlier,
    data: { displayNumber: '#405', placedAt: earlier },
    lines: [{ external: 'line-405', quantity: '1' }],
  });
  const apiOrigin = await f.app.listen({ host: '127.0.0.1', port: 0 });
  const web = startProcess(
    t,
    'e2e/web-server.mjs',
    { TEST_API_ORIGIN: apiOrigin, TEST_WEB_PORT: String(port) },
    true,
  );
  await web.message('listening');
  const context = await t.newContext({
    baseURL: origin,
    viewport: { width: 1440, height: 1000 },
  });
  await context.addCookies(
    f.member.cookie.split('; ').map((value) => {
      const [name, ...rest] = value.split('=');

      return { name, value: rest.join('='), url: origin };
    }),
  );
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await page.goto(`/app/${f.org.id}/insights?range=7d`);
  await page.getByRole('heading', { name: 'Operational trends' }).waitFor();
  const orders = page.getByRole('group', {
    name: 'Orders placed, last 7 days',
  });
  await orders.waitFor();
  // Hidden chart instructions and table captions must stay inside the content scroller.
  const checkScroll = async () => {
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollHeight <= window.innerHeight,
        ),
      )
      .toBe(true);
    await page.evaluate(() => window.scrollTo(0, 1600));
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    const content = page.locator('#workspace-content');
    await content.evaluate(
      (element) => (element.scrollTop = element.scrollHeight),
    );
    await expect
      .poll(() => content.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);
    expect(
      await page
        .locator('.desk-header')
        .evaluate((element) => element.getBoundingClientRect().top),
    ).toBeGreaterThanOrEqual(0);
    await content.evaluate((element) => (element.scrollTop = 0));
  };
  await checkScroll();
  // Sources without an import are named, and unknown history is never shown as complete.
  const card = page.locator('section[data-chart="orders"]');
  await expect(card).toContainText('Partial coverage');
  await expect(card).toContainText('Not fully imported');
  // Without complete history, the previous period isn't compared.
  await expect(card.locator('.insights-stats')).toContainText('Not comparable');
  // Current-state charts belong to Now; Trends shows only timelines.
  expect(await page.locator('section[data-chart="stock"]').count()).toBe(0);

  // The keyboard reaches the chart in one stop and opens the latest day with orders.
  const bars = orders.getByRole('button');
  const names = await bars.evaluateAll((elements) =>
    elements.map((element) => element.getAttribute('aria-label')),
  );
  const day = names.findLastIndex((name) => /: [1-9]\d* orders?\b/.test(name));
  expect(day).toBeGreaterThanOrEqual(0);
  await bars.first().focus();
  await page.keyboard.press('End');
  for (let index = names.length - 1; index > day; index--)
    await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Enter');
  const sheet = page.getByRole('dialog');
  await sheet.getByRole('heading', { name: /^Orders · / }).waitFor();
  await expect(sheet).toContainText('matches the chart');
  const total = Number(/: (\d+) orders?/.exec(names[day])[1]);
  expect(await sheet.getByRole('listitem').count()).toBe(total);

  // A record opens with a way back to these records.
  const drill = page.url();
  expect(new URL(drill).searchParams.get('chart')).toBe('orders');
  await sheet.getByRole('link', { name: /^#\d+/ }).first().click();
  await page.getByRole('link', { name: 'Back to previous page' }).click();
  await page.waitForURL(drill);
  await sheet.getByRole('heading', { name: /^Orders · / }).waitFor();

  // The Orders workspace opens with the same filters and the same count.
  await sheet
    .getByRole('link', { name: 'Open these orders in Orders' })
    .click();
  await page.waitForURL(`**/app/${f.org.id}/orders?**`);
  await expect(page.getByRole('link', { name: /^#\d+/ })).toHaveCount(total);
  await page.goBack();
  await sheet.waitFor();
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  expect(new URL(page.url()).searchParams.get('chart')).toBeNull();

  // Now keeps the source filter but leaves the range to Trends.
  await page.getByRole('tab', { name: 'Now' }).click();
  await expect
    .poll(() => new URL(page.url()).searchParams.get('view'))
    .toBe('now');
  await expect(page.getByRole('group', { name: 'Time range' })).toHaveCount(0);
  // Stock without rules is unknown, so the summary never says nothing needs attention.
  await expect(
    page.getByRole('region', { name: 'Needs attention' }),
  ).toContainText(/some counts are unknown/);
  // Without replenishment rules, stock risk says why instead of showing zeros.
  await expect(page.locator('section[data-chart="stock"]')).toContainText(
    'stock risk is unknown, not zero',
  );

  // The table view opens the same records as the bars.
  const backlog = page.locator('section[data-chart="fulfillment"]');
  await backlog.getByRole('tab', { name: 'Table', exact: true }).click();
  await backlog
    .getByRole('table', { name: 'Fulfillment backlog' })
    .getByRole('button', { name: /No progress\. Show the records\.$/ })
    .click();
  await sheet
    .getByRole('heading', { name: /No progress · 2–7 days$/ })
    .waitFor();
  await expect(sheet.getByRole('link', { name: /^#201/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await checkScroll();

  // The command menu opens a view directly.
  await page.keyboard.press('Control+k');
  await page
    .getByRole('textbox', { name: 'Search workspace' })
    .fill('outcomes');
  await page.getByRole('link', { name: /^Insights: Outcomes/ }).click();
  await expect
    .poll(() => new URL(page.url()).searchParams.get('view'))
    .toBe('outcomes');
  await page.goBack();

  await page.setViewportSize({ width: 390, height: 844 });
  await backlog.waitFor();
  await checkScroll();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);

  // The previous stretch opens its records like any chart point. Orders filter by whole
  // days, so no Orders link is offered for a stretch that ends at a time of day.
  await page.goto(
    `/app/${f.org.id}/insights?range=7d&chart=orders&point=previous`,
  );
  await sheet
    .getByRole('heading', { name: /^Orders · Previous period, / })
    .waitFor();
  await expect(sheet.getByRole('link', { name: /^#405/ })).toBeVisible();
  await expect(sheet.locator('.insights-sheet-count')).toContainText(
    'matches the chart',
  );
  await expect(
    sheet.getByRole('link', { name: 'Open these orders in Orders' }),
  ).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('keeps a 503 chart stable during live import events and supports explicit recovery', async ({
  resources: t,
}) => {
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  const f = await settingsFixture(t, origin);
  const apiOrigin = await f.app.listen({ host: '127.0.0.1', port: 0 });
  const web = startProcess(
    t,
    'e2e/web-server.mjs',
    { TEST_API_ORIGIN: apiOrigin, TEST_WEB_PORT: String(port) },
    true,
  );
  await web.message('listening');
  const context = await t.newContext({ baseURL: origin });
  await context.addCookies(
    f.member.cookie.split('; ').map((value) => {
      const [name, ...rest] = value.split('=');

      return { name, value: rest.join('='), url: origin };
    }),
  );
  const page = await context.newPage();
  await page.addInitScript(
    ({ organizationId }) => {
      window.EventSource = class extends EventTarget {
        constructor() {
          super();
          this.change = () =>
            this.dispatchEvent(
              new MessageEvent('resync', {
                data: JSON.stringify({
                  schemaVersion: 1,
                  organizationId,
                  scope: 'order-metrics',
                  connected: true,
                  refetch: true,
                  sentAt: new Date().toISOString(),
                }),
              }),
            );
          window.addEventListener('test-metric-change', this.change);
          queueMicrotask(this.change);
        }
        close() {
          window.removeEventListener('test-metric-change', this.change);
        }
      };
    },
    { organizationId: f.org.id },
  );
  let requests = 0;
  let failing = true;
  await page.route('**/insights/orders?**', async (route) => {
    requests++;
    if (!failing) return route.continue();
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({
        code: 'SERVICE_UNAVAILABLE',
        message: 'Order history is being prepared for charts.',
        requestId: 'test',
      }),
    });
  });
  await page.clock.install();
  await page.goto(`/app/${f.org.id}/insights?view=trends`);
  const card = page.locator('section[data-chart="orders"]');
  await expect(card.getByRole('alert')).toContainText(
    'Order history is being prepared',
  );
  await page.clock.runFor(1000);
  await expect(
    page.getByRole('button', { name: 'Refresh insights' }),
  ).toBeEnabled();
  const initialRequests = requests;
  for (let index = 0; index < 10; index++) {
    await page.evaluate(() =>
      window.dispatchEvent(new Event('test-metric-change')),
    );
    await page.clock.runFor(1000);
    await expect(
      page.getByRole('button', { name: 'Refresh insights' }),
    ).toBeEnabled();
    await expect(card.getByRole('alert')).toContainText(
      'Order history is being prepared',
    );
  }
  expect(requests).toBe(initialRequests);
  failing = false;
  await card.getByRole('button', { name: 'Try again' }).click();
  await expect(card.getByRole('alert')).toBeHidden();
  await expect(card).toContainText('No source reports orders yet');
  expect(requests).toBe(initialRequests + 1);
});

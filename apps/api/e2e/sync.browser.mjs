/* global document */
import { expect, test } from './browser-fixtures.mjs';
import { availablePort, startProcess } from './helpers.mjs';
import { syncFixture } from './sync-fixture.mjs';

test('follows history import coverage, explains waits and pauses a sync', async ({
  resources: t,
}) => {
  const port = await availablePort(),
    origin = `http://127.0.0.1:${port}`;
  const f = await syncFixture(t, origin);
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
    f.owner.cookie.split('; ').map((value) => {
      const [name, ...rest] = value.split('=');

      return { name, value: rest.join('='), url: origin };
    }),
  );
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await page.goto(`/app/${f.org.id}/orders`);
  // The list states its coverage in one line; per-source detail opens beneath it.
  await page
    .getByText('Importing from the source (41%) · list is incomplete', {
      exact: false,
    })
    .waitFor();
  await page.locator('.sync-coverage summary').click();
  await page.getByText('importing orders (41%)', { exact: false }).waitFor();
  await page.getByRole('link', { name: 'Open Data sync', exact: true }).click();
  await page.getByRole('heading', { name: 'Data sync', exact: true }).waitFor();
  await page.getByRole('heading', { name: 'Importing history' }).waitFor();
  const progress = page.getByRole('progressbar', {
    name: 'Orders history import',
  });
  expect(await progress.getAttribute('aria-valuetext')).toBe(
    '50 of 120 orders',
  );
  await page
    .getByText('Not part of this connection', { exact: true })
    .first()
    .waitFor();
  await page.screenshot({ path: '/tmp/luma96-sync-light.png', fullPage: true });

  await f.db.owner.query(
    `UPDATE commerce_sync_streams SET lease_until=NULL,lease_token=NULL,
      admission_wait_reason='request_capacity',admission_wait_at=now(),due_at=now()+interval '1 minute'
      WHERE tenant_id=$1 AND id=$2`,
    [f.org.id, f.stream],
  );
  await page.getByRole('button', { name: 'Refresh sync status' }).click();
  await page
    .getByRole('group', { name: 'Orders: Waiting', exact: true })
    .waitFor();
  await expect(
    page.getByText('Waiting for request capacity. Luma retries automatically.'),
  ).toBeVisible();
  await expect(
    page.getByText('50 of 120 orders', { exact: true }),
  ).toBeVisible();
  await expect(progress).toHaveCount(0);

  const busy = '00000000-0000-4000-8000-000000000099';
  await f.db.owner.query(
    `INSERT INTO commerce_sync_streams(tenant_id,id,connection_id,record_type,principal_id,phase,
      lease_token,lease_until,lease_workspace_concurrency,lease_connection_concurrency)
      VALUES($1,$2,$3,'orders',$4,'incremental',$2,now()+interval '1 minute',1,1)`,
    [f.org.id, busy, f.erp, f.owner.id],
  );
  await f.db.owner.query(
    `UPDATE commerce_sync_streams SET admission_wait_reason=NULL,admission_wait_at=NULL,due_at=now()
      WHERE tenant_id=$1 AND id=$2`,
    [f.org.id, f.stream],
  );
  await page.getByRole('button', { name: 'Refresh sync status' }).click();
  await expect(
    page.getByText('Waiting for sync capacity. Currently syncing: JTL-Wawi.'),
  ).toBeVisible();
  await f.db.owner.query(
    'DELETE FROM commerce_sync_streams WHERE tenant_id=$1 AND id=$2',
    [f.org.id, busy],
  );
  await f.db.owner.query(
    `UPDATE commerce_sync_streams SET lease_token=$2,lease_until=now()+interval '5 minutes'
      WHERE tenant_id=$1 AND id=$2`,
    [f.org.id, f.stream],
  );
  await page.getByRole('button', { name: 'Refresh sync status' }).click();
  await page
    .getByRole('group', { name: 'Orders: Importing history', exact: true })
    .waitFor();
  await expect(
    page.getByText('Waiting for sync capacity. Currently syncing: JTL-Wawi.'),
  ).toHaveCount(0);
  await expect(progress).toHaveAttribute('aria-valuetext', '50 of 120 orders');

  await f.db.owner.query(
    `UPDATE commerce_sync_streams SET recent_history_from=now()-interval '30 days',
    recent_history_completed_at=now(),scan_waiting=true WHERE tenant_id=$1 AND id=$2`,
    [f.org.id, f.stream],
  );
  await page.getByRole('button', { name: 'Refresh sync status' }).click();
  await page.getByText('Recent history imported', { exact: true }).waitFor();
  await page.getByText('Preparing history', { exact: true }).waitFor();
  expect(await progress.getAttribute('aria-valuetext')).toBe(
    'The source is preparing an export',
  );
  await page.screenshot({
    path: '/tmp/luma122-sync-recent-light.png',
    fullPage: true,
  });

  await page
    .getByRole('button', { name: 'Orders sync actions' })
    .first()
    .click();
  await page.getByRole('menuitem', { name: 'Pause' }).click();
  await page.getByText('Sync paused.', { exact: false }).waitFor();
  await page.getByRole('group', { name: 'Orders: Paused' }).waitFor();
  await page.getByRole('heading', { name: 'History import paused' }).waitFor();

  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await page.screenshot({
    path: '/tmp/luma122-sync-recent-dark.png',
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true);
  await page
    .getByText('Recent history imported', { exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: '/tmp/luma122-sync-recent-mobile.png',
    fullPage: true,
  });
  expect(errors).toEqual([]);
});

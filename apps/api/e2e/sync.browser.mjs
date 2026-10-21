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
  await f.db.owner.query(
    `INSERT INTO commerce_sync_runs(tenant_id,id,stream_id,kind,trigger,full_scan,started_at,outcome,pages,records,changed)
      VALUES($1,gen_random_uuid(),$2,'backfill','connection',true,now()-interval '20 minutes','running',2,50,50)`,
    [f.org.id, f.stream],
  );
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
  // The row's meter; the detail pane shows the same import beside the list.
  const progress = page
    .getByRole('list', { name: /^Record types from / })
    .getByRole('progressbar', {
      name: 'Orders history import',
    });
  expect(await progress.getAttribute('aria-valuetext')).toBe(
    '50 of 120 orders',
  );
  // Record types a connection doesn't sync collapse into one line under it.
  await page
    .getByText(/^Not part of this connection: /)
    .first()
    .waitFor();

  await f.db.owner.query(
    `UPDATE commerce_sync_streams SET lease_until=NULL,lease_token=NULL,
      admission_wait_reason='request_capacity',admission_wait_at=now(),due_at=now()+interval '1 minute'
      WHERE tenant_id=$1 AND id=$2`,
    [f.org.id, f.stream],
  );
  await page.getByRole('button', { name: 'Refresh sync status' }).click();
  const waitingRow = page.getByRole('link', {
    name: 'Orders: Waiting for rate limit',
    exact: true,
  });
  await waitingRow.waitFor();
  await expect(
    waitingRow.getByText(
      'Luma is waiting for request capacity to stay within the source’s rate limit. It will retry automatically.',
    ),
  ).toBeVisible();
  // The row opens the sync's detail beside the list, which explains the wait.
  await waitingRow.click();
  await page.waitForURL(/[?&]stream=/);
  const detail = page.getByRole('region', { name: 'Sync details' });
  await expect(
    detail.getByText(
      'Luma is waiting for request capacity to stay within the source’s rate limit. It will retry automatically.',
    ),
  ).toBeVisible();
  // Run history loads for the open sync only.
  await expect(
    detail.getByText('History import', { exact: true }).last(),
  ).toBeVisible();
  await expect(detail.getByText('50 imported or updated')).toBeVisible();
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
    detail.getByText('Waiting for sync capacity. Currently syncing: JTL-Wawi.'),
  ).toBeVisible();
  await f.db.owner.query(
    'DELETE FROM commerce_sync_streams WHERE tenant_id=$1 AND id=$2',
    [f.org.id, busy],
  );
  await f.db.owner.query(
    `UPDATE commerce_sync_streams SET due_at=now()-interval '4 minutes'
      WHERE tenant_id=$1 AND id=$2`,
    [f.org.id, f.stream],
  );
  await page.getByRole('button', { name: 'Refresh sync status' }).click();
  await expect(
    page.getByRole('heading', { name: '1 sync is delayed' }),
  ).toBeVisible();
  const delayedRow = page.getByRole('link', {
    name: 'Orders: Sync delayed',
    exact: true,
  });
  const delayedText =
    'This sync is overdue and has not been picked up yet. Imported records remain available.';
  await expect(delayedRow.getByText(delayedText)).toBeVisible();
  await expect(detail.getByText(delayedText)).toBeVisible();
  await expect(
    page.getByText('50 of 120 orders', { exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await f.db.owner.query(
    `UPDATE commerce_sync_streams SET lease_token=$2,lease_until=now()+interval '5 minutes'
      WHERE tenant_id=$1 AND id=$2`,
    [f.org.id, f.stream],
  );
  await page.getByRole('button', { name: 'Refresh sync status' }).click();
  await page
    .getByRole('link', { name: 'Orders: Importing history', exact: true })
    .waitFor();
  await expect(
    page.getByText('Waiting for sync capacity. Currently syncing: JTL-Wawi.'),
  ).toHaveCount(0);
  await expect(progress).toHaveAttribute('aria-valuetext', '50 of 120 orders');
  await expect(page.getByText(delayedText)).toHaveCount(0);

  await f.db.owner.query(
    `UPDATE commerce_sync_streams SET recent_history_from=now()-interval '30 days',
    recent_history_completed_at=now(),scan_waiting=true WHERE tenant_id=$1 AND id=$2`,
    [f.org.id, f.stream],
  );
  await page.getByRole('button', { name: 'Refresh sync status' }).click();
  await detail.getByText(/^Recent history since/).waitFor();
  await page.getByText('Preparing history', { exact: true }).first().waitFor();
  expect(await progress.getAttribute('aria-valuetext')).toBe(
    'The source is preparing an export',
  );

  await detail.getByRole('button', { name: 'Pause', exact: true }).click();
  // The outcome shows next to the sync it changed.
  await detail.getByText('Sync paused.', { exact: false }).waitFor();
  await page.getByRole('link', { name: 'Orders: Paused' }).waitFor();
  await page.getByRole('heading', { name: 'History import paused' }).waitFor();
  await detail.getByRole('button', { name: 'Resume', exact: true }).waitFor();

  // Escape closes the detail and keeps the list in place.
  await page.keyboard.press('Escape');
  await expect(detail).toBeHidden();
  await expect(page).not.toHaveURL(/[?&]stream=/);

  // A link naming a connection and record type, as issues use, opens that sync.
  await f.db.owner.query(
    `INSERT INTO commerce_sync_items(tenant_id,connection_id,record_type,resource,scope_key,external_id,digest,status,
      problem,first_seen_at,last_seen_at,changed_at,first_seen_by)
    VALUES($1,$2,'orders','order','tokyo.myshopify.com','gid://shopify/Order/9','d','failed',
      'The source record does not match Luma’s record rules',now(),now(),now(),'backfill')`,
    [f.org.id, f.store],
  );
  await page.goto(`/app/${f.org.id}/sync?connection=${f.store}&type=orders`);
  await page.waitForURL(new RegExp(`[?&]stream=${f.stream}`));
  await expect(page).not.toHaveURL(/[?&]connection=/);
  // Records that couldn't import are listed by source ID beneath their count.
  await detail.getByRole('button', { name: 'Show orders' }).click();
  const failed = detail.getByRole('list', { name: '1 order couldn’t import' });
  await expect(failed.getByText('gid://shopify/Order/9')).toBeVisible();
  await expect(
    failed.getByText('The source record does not match Luma’s record rules'),
  ).toBeVisible();

  // Connection-wide commands change every matching sync in one request.
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Tokyo store sync actions' }).click();
  await page.getByRole('menuitem', { name: 'Resume all' }).click();
  await page
    .getByText('Resumed 1 sync of Tokyo store with your access.')
    .waitFor();
  expect(
    (
      await f.db.owner.query(
        'SELECT paused FROM commerce_sync_streams WHERE tenant_id=$1 AND id=$2',
        [f.org.id, f.stream],
      )
    ).rows,
  ).toEqual([{ paused: false }]);

  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true);
  await page
    .getByText(/recent history complete/)
    .first()
    .scrollIntoViewIfNeeded();
  expect(errors).toEqual([]);
});

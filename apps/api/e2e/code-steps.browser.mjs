/* global document, innerWidth */

import { expect, test } from './browser-fixtures.mjs';
import { seedCodeSteps } from './code-steps-fixture.mjs';
import { createAccount, database, startApi } from './helpers.mjs';

test('reviews and evaluates a code example on desktop and mobile', async ({
  resources: t,
  web,
}) => {
  const origin = web.origin;
  const db = await database(t);
  await db.migrate();
  await db.grantRuntime();
  await db.owner.query(
    `GRANT luma_connectors TO "${new URL(db.runtimeUrl).username}"`,
  );
  const api = await startApi(t, db, origin, 'e2e/code-server.mjs');
  await web.route(api.origin);
  const page = await t.newPage({
    baseURL: origin,
    viewport: { width: 1440, height: 1000 },
  });
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await createAccount(page, db, {
    name: 'Ada',
    email: 'code@example.test',
    password: 'browser-test-password-123',
  });
  await page.getByLabel('Workspace name').fill('Code studio');
  await page
    .getByRole('button', { name: 'Create workspace', exact: true })
    .click();
  await page.getByRole('heading', { name: 'Needs you' }).waitFor();
  const tenantId = new URL(page.url()).pathname.split('/')[2];
  const { version } = await seedCodeSteps(db, tenantId);
  await page.goto(`/app/${tenantId}/workflows/${version.definition.id}`);
  await page.getByRole('tab', { name: 'Details', exact: true }).click();
  await page.getByLabel('TypeScript source', { exact: true }).waitFor();
  await page.getByRole('tab', { name: 'Test example' }).click();
  await page
    .getByLabel('Example inputs', { exact: true })
    .fill(
      JSON.stringify(
        { inputs: { quantity: 3 }, evidence: {}, steps: {} },
        null,
        2,
      ),
    );
  await page
    .getByLabel('Expected outputs', { exact: true })
    .fill('{"wrong":6}');
  await page.getByRole('button', { name: 'Run test', exact: true }).click();
  await page
    .getByText(
      'Example inputs and expected outputs must match the declared fields.',
      { exact: true },
    )
    .waitFor();
  expect(
    await page.getByLabel('Expected outputs', { exact: true }).isEnabled(),
  ).toBe(true);
  expect(
    await page.getByLabel('Example inputs', { exact: true }).isEnabled(),
  ).toBe(true);
  await page
    .getByLabel('Expected outputs', { exact: true })
    .fill('{"value":6}');
  await page.getByRole('button', { name: 'Run test', exact: true }).click();
  await page.getByText('Example passed', { exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole('tab', { name: 'Test example' })
    .evaluate((element) =>
      element.scrollIntoView({ block: 'center', behavior: 'instant' }),
    );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
});

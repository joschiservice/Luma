/* global document, innerWidth */

import { expect, test } from './browser-fixtures.mjs';
import {
  availablePort,
  createAccount,
  database,
  startApi,
  startProcess,
} from './helpers.mjs';

test('drafts a workflow from a description and applies a reviewed change', async ({
  resources: t,
}) => {
  const port = await availablePort(),
    origin = `http://127.0.0.1:${port}`;
  const db = await database(t);
  await db.migrate();
  await db.grantRuntime();
  await db.owner.query(
    `GRANT luma_connectors TO "${new URL(db.runtimeUrl).username}"`,
  );
  // Only Bedrock's HTTPS endpoints are intercepted; the route, checks and storage are real.
  const api = await startApi(t, db, origin, 'e2e/authoring-server.mjs');
  await startProcess(
    t,
    'e2e/web-server.mjs',
    { TEST_API_ORIGIN: api.origin, TEST_WEB_PORT: String(port) },
    true,
  ).message('listening');
  const page = await t.newPage({
    baseURL: origin,
    viewport: { width: 1440, height: 1000 },
  });
  page.setDefaultTimeout(20000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await createAccount(page, db, {
    name: 'Grace',
    email: 'describer@example.test',
    password: 'browser-test-password-123',
  });
  await page.getByLabel('Workspace name').fill('Describing studio');
  await page
    .getByRole('button', { name: 'Create workspace', exact: true })
    .click();
  await page.getByRole('heading', { name: 'Needs you' }).waitFor();
  const tenantId = new URL(page.url()).pathname.split('/')[2];

  await page.goto(`/app/${tenantId}/workflows/new`);
  await page.getByRole('button', { name: 'Describe a workflow' }).click();
  const dialog = page.getByRole('dialog', { name: 'Describe a workflow' });
  await dialog
    .getByLabel('What should happen?')
    .fill(
      'When a SKU drops below 20 units, draft a purchase order for the usual supplier and ask me to approve it.',
    );
  await dialog.getByRole('button', { name: 'Draft workflow' }).click();

  // The draft opens in the builder with its assumptions and open questions highlighted.
  await page
    .getByRole('heading', { name: 'Reorder low stock', level: 1 })
    .waitFor();
  const assistant = page.getByRole('region', { name: 'From your description' });
  await assistant
    .getByText('The usual supplier is the one set for this stock position.')
    .waitFor();
  await assistant
    .getByText('Should the quantity come from the replenishment proposal?')
    .waitFor();
  await page
    .getByRole('list', { name: 'Workflow steps' })
    .getByText('Question')
    .first()
    .waitFor();
  await page
    .getByText(/^When below minimum is yes, read current stock/)
    .waitFor();

  // A follow-up instruction becomes a step-level proposal; nothing changes until it's accepted.
  await page.getByText('All changes saved').waitFor();
  await assistant
    .getByLabel('What should change?')
    .fill('Wait ten minutes before checking stock.');
  await assistant.getByRole('button', { name: 'Propose change' }).click();
  const proposal = assistant.getByLabel('Proposed change');
  await proposal.getByText('Added').first().waitFor();
  expect(
    await page
      .getByRole('list', { name: 'Workflow steps' })
      .getByText('Wait 10 minute(s).')
      .count(),
  ).toBe(0);
  await proposal.getByRole('button', { name: 'Accept change' }).click();
  await page
    .getByRole('list', { name: 'Workflow steps' })
    .getByText('Wait 10 minute(s).')
    .waitFor();

  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
});

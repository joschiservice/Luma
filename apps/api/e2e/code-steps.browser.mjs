/* global document, innerWidth */
import { mkdir } from 'node:fs/promises';

import { chromium } from 'playwright';
import { expect, it } from 'vitest';

import { seedCodeSteps } from './code-steps-fixture.mjs';
import { availablePort, database, startApi, startProcess } from './helpers.mjs';

it('reviews and evaluates a code example on desktop and mobile', async (t) => {
  const port = await availablePort(),
    origin = `http://127.0.0.1:${port}`;
  const db = await database(t);
  await db.migrate();
  await db.grantRuntime();
  await db.owner.query(
    `GRANT luma_connectors TO "${new URL(db.runtimeUrl).username}"`,
  );
  const api = await startApi(t, db, origin, 'e2e/code-server.mjs');
  await startProcess(
    t,
    'e2e/web-server.mjs',
    { TEST_API_ORIGIN: api.origin, TEST_WEB_PORT: String(port) },
    true,
  ).message('listening');
  const browser = await chromium.launch();
  t.onTestFinished(() => browser.close());
  const page = await browser.newPage({
    baseURL: origin,
    viewport: { width: 1440, height: 1000 },
  });
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/sign-up');
  await page.getByLabel('Name', { exact: true }).fill('Ada');
  await page.getByLabel('Email', { exact: true }).fill('code@example.test');
  await page
    .getByLabel('Password', { exact: true })
    .fill('browser-test-password-123');
  await page
    .getByRole('button', { name: 'Create account', exact: true })
    .click();
  await page.getByLabel('Workspace name').fill('Code studio');
  await page
    .getByRole('button', { name: 'Create workspace', exact: true })
    .click();
  await page.getByRole('heading', { name: 'Operations overview' }).waitFor();
  const tenantId = new URL(page.url()).pathname.split('/')[2];
  const { version } = await seedCodeSteps(db, tenantId);
  await page.goto(`/app/${tenantId}/workflows/${version.definition.id}`);
  await mkdir('/tmp/luma51-browser', { recursive: true });
  await page.screenshot({
    path: '/tmp/luma51-browser/before.png',
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Code Steps', exact: true }).click();
  await page.getByLabel('TypeScript source', { exact: true }).waitFor();
  await mkdir('/tmp/luma51-browser', { recursive: true });
  await page.screenshot({
    path: '/tmp/luma51-browser/source-desktop.png',
    fullPage: true,
  });
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
  await page
    .getByRole('button', { name: 'Run evaluation', exact: true })
    .click();
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
  await page
    .getByRole('button', { name: 'Run evaluation', exact: true })
    .click();
  await page.getByText('Example passed', { exact: true }).waitFor();
  await page.screenshot({
    path: '/tmp/luma51-browser/evaluation-desktop.png',
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole('tab', { name: 'Test example' })
    .evaluate((element) =>
      element.scrollIntoView({ block: 'center', behavior: 'instant' }),
    );
  await page.screenshot({
    path: '/tmp/luma51-browser/evaluation-mobile.png',
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
});

/* global document, innerWidth */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { chromium } from '../../apps/api/node_modules/playwright/index.mjs';
import { createApp } from '../../apps/simulator/dist/app.js';

test('control panel manages runs, merchant actions and every initial fault', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'luma44-browser-'));
  const app = await createApp(
    join(directory, 'runs.sqlite'),
    'local-synthetic-simulator-token',
  );
  const url = await app.listen({ host: '127.0.0.1', port: 0 });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1100 },
    });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(url);
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await page.getByRole('button', { name: 'Create run', exact: true }).click();
    await page.waitForFunction(() =>
      document.querySelector('#status').textContent.includes('Paused'),
    );
    await page.getByRole('button', { name: 'Start / Resume' }).click();
    await page.waitForFunction(() =>
      document.querySelector('#status').textContent.includes('Running'),
    );
    await page.getByRole('button', { name: 'Pause', exact: true }).click();
    await page.waitForFunction(() =>
      document.querySelector('#status').textContent.includes('Paused'),
    );
    await page.getByRole('button', { name: 'Advance 30s' }).click();
    await page.waitForFunction(() =>
      document.querySelector('#state').textContent.includes('SIM-11'),
    );
    await page.locator('#speed').selectOption('20');
    await page.waitForFunction(() =>
      document.querySelector('#status').textContent.includes('20×'),
    );
    await page.locator('#command [name=kind]').selectOption('shipping-method');
    await page.locator('#command [name=id]').fill('1');
    await page.locator('#command [name=shippingMethodId]').selectOption('9');
    await page.getByRole('button', { name: 'Apply action' }).click();
    await page.waitForFunction(() =>
      document
        .querySelector('#state')
        .textContent.includes('"shippingMethodId": "9"'),
    );
    for (const fault of ['outage', 'rate-limit', 'response-loss']) {
      await page.locator('#fault [name=kind]').selectOption(fault);
      await page.getByRole('button', { name: 'Arm fault' }).click();
      await page.waitForFunction(
        (kind) =>
          Array.from(document.querySelectorAll('.fault')).some((row) =>
            row.textContent.includes(kind),
          ),
        fault,
      );
    }
    assert.equal(await page.locator('.fault').count(), 3);
    await page
      .getByRole('button', { name: 'Disable', exact: true })
      .first()
      .click();
    await page.waitForFunction(() =>
      document.querySelector('.fault').textContent.includes('disabled'),
    );
    await page.screenshot({
      path: '/tmp/luma44-control-panel.png',
      fullPage: true,
    });
    await page.locator('#provider').selectOption('shopify');
    await page.waitForFunction(() =>
      document
        .querySelector('#state')
        .textContent.includes('gid://shopify/Order/11'),
    );
    await page.getByRole('button', { name: 'Reset run' }).click();
    await page.waitForFunction(
      () =>
        !document
          .querySelector('#state')
          .textContent.includes('gid://shopify/Order/11'),
    );
    assert.equal(await page.locator('.fault').count(), 0);
    assert.equal(await page.locator('#error').textContent(), '');
    assert.deepEqual(errors, []);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    // The host advances with no page open.
    await page.getByRole('button', { name: 'Start / Resume' }).click();
    await page.waitForFunction(() =>
      document.querySelector('#status').textContent.includes('Running'),
    );
    await page.close();
    const headers = { authorization: 'Bearer local-synthetic-simulator-token' };
    const before = (
      await (await fetch(`${url}/api/runs`, { headers })).json()
    )[0].clock.now;
    await new Promise((resolve) => setTimeout(resolve, 500));
    const after = (
      await (await fetch(`${url}/api/runs`, { headers })).json()
    )[0].clock.now;
    assert.ok(after > before);
  } finally {
    await browser.close();
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

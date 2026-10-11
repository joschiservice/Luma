/* global document, window */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { chromium } from 'playwright';

import { createApp } from '../../apps/simulator/dist/app.js';
import { testSimulatorDatabase } from './database.mjs';

const token = 'local-synthetic-simulator-token';

/** Waits up to five seconds for an asynchronous condition. */
async function until(condition) {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

test('control panel creates runs, changes health and chaos, and arms fault rules', async (t) => {
  const databaseUrl = await testSimulatorDatabase(t);
  const app = await createApp({ databaseUrl, token, autonomous: false });
  const url = await app.listen({ host: '127.0.0.1', port: 0 });
  const browser = await chromium.launch({ headless: true });
  const api = async (path) =>
    (
      await fetch(`${url}/api/${path}`, {
        headers: { authorization: `Bearer ${token}` },
      })
    ).json();
  // Hosts close inside the test: after hooks run first-in-first-out, before the database drop.
  try {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1100 },
    });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(url);
    await page.getByText('No runs yet').first().waitFor();
    await page.getByRole('button', { name: 'New run' }).click();
    const dialog = page.getByRole('dialog', { name: 'Create a run' });
    await dialog.getByLabel('Run ID').fill('panel');
    await dialog.getByText('Test fixture').click();
    await dialog.getByRole('button', { name: 'Create run' }).click();
    await page.getByText('Ready', { exact: true }).first().waitFor();
    assert.equal((await api('runs/panel')).profile.name, 'test');

    await page
      .getByRole('combobox', { name: 'Service health of JTL-Wawi' })
      .click();
    await page.getByRole('option', { name: 'Unavailable' }).click();
    await until(
      async () =>
        (await api('runs/panel')).instances[0].health === 'unavailable',
    );
    assert.equal((await api('runs/panel')).instances[0].health, 'unavailable');

    await page.getByRole('tab', { name: 'Chaos' }).click();
    await page.getByRole('radio', { name: /Bad day/ }).check();
    await page.getByRole('button', { name: 'Apply chaos profile' }).click();
    await until(
      async () => (await api('runs/panel')).chaos.preset === 'bad-day',
    );
    assert.equal((await api('runs/panel')).chaos.preset, 'bad-day');

    await page.getByRole('button', { name: 'Arm fault' }).click();
    await until(async () => (await api('runs/panel')).faults.length);
    const [fault] = (await api('runs/panel')).faults;
    assert.equal(fault.status, 'armed');
    await page
      .getByRole('button', { name: `Disable rule ${fault.id}` })
      .click();
    await until(
      async () => (await api('runs/panel')).faults[0].status === 'disabled',
    );
    assert.equal((await api('runs/panel')).faults[0].status, 'disabled');

    await page.getByRole('button', { name: 'Advance 5 min' }).click();
    await page
      .getByText(/ahead of real time/i)
      .first()
      .waitFor();
    await page.getByRole('tab', { name: 'Journal' }).click();
    await page.getByText('control').first().waitFor();

    // A supplier's email delivered from the panel appears as a thread in the mailbox.
    await page.getByRole('tab', { name: 'Mailbox' }).click();
    await page.getByLabel('Subject').fill('Teillieferung BE-00001');
    await page.getByLabel('Message').fill('60 Stück folgen am Freitag.');
    await page.getByRole('button', { name: 'Deliver mail' }).click();
    await page.getByText('Delivered.', { exact: false }).waitFor();
    await page.getByRole('button', { name: 'Teillieferung BE-00001' }).click();
    await page.getByText('60 Stück folgen am Freitag.').waitFor();

    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
      true,
    );
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await app.close();
  }
});

/* global document, innerWidth */
import { mkdir } from 'node:fs/promises';

import { expect, test } from './browser-fixtures.mjs';
import { availablePort, database, startApi, startProcess } from './helpers.mjs';

const screenshots = '/tmp/luma88-browser';

test('creates workflows from templates and from scratch, then publishes without activating', async ({
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
  const api = await startApi(t, db, origin);
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
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await mkdir(screenshots, { recursive: true });

  await page.goto('/sign-up');
  await page.getByRole('radio', { name: /Australia/ }).check();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill('Ada');
  await page.getByLabel('Email', { exact: true }).fill('author@example.test');
  await page
    .getByLabel('Password', { exact: true })
    .fill('browser-test-password-123');
  await page
    .getByRole('button', { name: 'Create account', exact: true })
    .click();
  await page.getByLabel('Workspace name').fill('Authoring studio');
  await page
    .getByRole('button', { name: 'Create workspace', exact: true })
    .click();
  await page.getByRole('heading', { name: 'Needs your attention' }).waitFor();
  const tenantId = new URL(page.url()).pathname.split('/')[2];

  // The gallery shows each template's requirements before configuration starts.
  await page.goto(`/app/${tenantId}/workflows`);
  await page.getByRole('link', { name: 'New workflow' }).first().click();
  await page.getByRole('heading', { name: 'New workflow', level: 1 }).waitFor();
  await page.getByRole('heading', { name: 'Replenish low stock' }).waitFor();
  await expect(
    page.getByRole('link', { name: 'Add a supplier' }).isVisible(),
  ).resolves.toBe(true);
  await page.screenshot({
    path: `${screenshots}/gallery-desktop.png`,
    fullPage: true,
  });
  // Without an AU zero-retention model route, describing a workflow says why it's unavailable.
  await page.getByRole('button', { name: 'Describe a workflow' }).click();
  const describe = page.getByRole('dialog', { name: 'Describe a workflow' });
  await describe.getByText(/model route/i).waitFor();
  expect(
    await describe.getByRole('button', { name: 'Draft workflow' }).isDisabled(),
  ).toBe(true);
  await describe.getByRole('button', { name: 'Cancel' }).click();
  await page.getByRole('button', { name: 'Use template' }).first().click();
  const dialog = page.getByRole('dialog', {
    name: 'Use “Replenish low stock”',
  });
  await dialog.waitFor();
  expect(
    await dialog.getByRole('button', { name: 'Continue' }).isDisabled(),
  ).toBe(true);
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  // Customizing copies the template into a draft; the template stays unchanged.
  await page.getByRole('button', { name: 'Customize' }).first().click();
  await page
    .getByRole('heading', { name: 'Replenish low stock (custom)', level: 1 })
    .waitFor();
  await page.getByText('Ready to publish').waitFor();
  await page
    .getByText(/can’t run in this workspace yet/)
    .first()
    .waitFor();
  await page.screenshot({
    path: `${screenshots}/customized-desktop.png`,
    fullPage: true,
  });

  // Test the copy with a simulator scenario; nothing reaches a connected system.
  await page.getByRole('tab', { name: 'Test' }).click();
  await page.getByRole('button', { name: 'New test' }).click();
  await page.getByRole('combobox', { name: 'Fill in from' }).click();
  await page
    .getByRole('option', { name: 'Scenario · Approved and verified' })
    .click();
  await page.getByRole('combobox', { name: 'Expected result' }).click();
  await page
    .getByRole('option', { name: 'Finished with a verified result' })
    .click();
  await page.getByRole('button', { name: 'Run without saving' }).click();
  const result = page.getByRole('region', { name: 'Test result' });
  await result.getByText('Passed', { exact: true }).waitFor();
  await result.getByText('Check the purchase-order draft').first().waitFor();
  await page.getByRole('button', { name: 'Save test' }).click();
  await page
    .getByRole('list', { name: 'Saved tests' })
    .getByText('Passed', { exact: true })
    .waitFor();
  await page.screenshot({
    path: `${screenshots}/test-desktop.png`,
    fullPage: true,
  });
  await page.getByRole('tab', { name: 'Build' }).click();

  // Build from scratch with the keyboard, then publish.
  await page.goto(`/app/${tenantId}/workflows/new`);
  await page.getByRole('button', { name: 'Build a workflow' }).click();
  await page
    .getByRole('heading', { name: 'Untitled workflow', level: 1 })
    .waitFor();
  await page.getByLabel('Name', { exact: true }).fill('Escalate held orders');
  await page.getByLabel('What it’s for').fill('Hand held orders to a person.');
  await page.getByRole('combobox', { name: 'What it acts on' }).click();
  await page.getByRole('option', { name: 'Order', exact: true }).click();
  // Drag a Code Step from the palette to the top of the list.
  const code = page.getByRole('button', { name: 'Add step: Run a code step' });
  await code.scrollIntoViewIfNeeded();
  const from = await code.boundingBox();
  await page.mouse.move(from.x + 20, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + 10, from.y + 30, { steps: 5 });
  await page.getByText('Drop here').first().waitFor();
  // Slots grow while a drag is in progress. Follow the first one, and release only once its
  // box has stopped moving and it shows that it receives the step.
  const slot = page.locator('.authoring-slot').first();
  const release = page.getByText('Release to add here');
  let previous;
  await expect
    .poll(
      async () => {
        const to = await slot.boundingBox();
        const settled =
          previous !== undefined &&
          Math.abs(previous.y - to.y) < 1 &&
          Math.abs(previous.height - to.height) < 1;
        previous = to;
        await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, {
          steps: 2,
        });

        return settled && (await release.isVisible());
      },
      { timeout: 15_000 },
    )
    .toBe(true);
  await page.mouse.up();
  const steps = page.getByRole('list', { name: 'Workflow steps' });
  await steps.getByText('Compute result with sandboxed TypeScript.').waitFor();
  // Reorder with the keyboard through the drag handle, then back with the step menu.
  await page.getByRole('button', { name: 'Reorder step 1' }).focus();
  // Wait for each announcement: the sensor starts listening for moves after it picks a step up.
  await page.keyboard.press('Space');
  await page
    .getByText(/is now at position 1 of 2/)
    .waitFor({ state: 'attached' });
  // Pickup announces before the keyboard sensor installs its movement listener. Repeat toward
  // the final slot only until its announcement confirms that the movement was received.
  await expect
    .poll(
      async () => {
        const moved = page.getByText(/is now at position 2 of 2/);
        if (await moved.count()) return true;
        await page.keyboard.press('ArrowDown');

        return (await moved.count()) > 0;
      },
      { timeout: 15_000 },
    )
    .toBe(true);
  await page.keyboard.press('Space');
  await steps
    .getByText(
      'Only the last step can finish or escalate. Move this step to the end.',
    )
    .waitFor();
  await page.getByRole('button', { name: 'Actions for step 2' }).click();
  await page.getByRole('menuitem', { name: 'Move up' }).click();
  await page.getByText('All changes saved').waitFor();
  await page.getByText('Ready to publish').waitFor();
  await page
    .getByRole('heading', { name: 'Steps', level: 2, exact: true })
    .evaluate((node) => node.scrollIntoView({ block: 'start' }));
  await page.screenshot({ path: `${screenshots}/builder-desktop.png` });

  // The code view shows the same draft and reports problems on their line.
  await page.getByRole('tab', { name: 'Code' }).click();
  const editor = page.getByRole('textbox', { name: 'Workflow code' });
  await editor.waitFor();
  expect(await editor.textContent()).toContain('defineWorkflow(');
  await editor.click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('oops');
  await page.getByText(/^Not saved: Line \d+, column \d+:/).waitFor();
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  await page.getByText('All changes saved').waitFor();
  await page.getByRole('tab', { name: 'Build' }).click();

  await page.getByRole('button', { name: 'Publish…' }).click();
  const publish = page.getByRole('dialog', { name: 'Publish version 1.0.0' });
  await publish.getByLabel('Version notes').fill('First version');
  await publish.getByRole('button', { name: 'Publish version 1.0.0' }).click();
  await page
    .getByRole('heading', { name: 'Escalate held orders' })
    .first()
    .waitFor({ state: 'attached' });
  expect(page.url()).toMatch(/\/workflows\/custom-/);
  await page.getByText('Blocked', { exact: true }).first().waitFor();
  await page.getByRole('heading', { name: 'Can’t run right now' }).waitFor();
  await page.screenshot({
    path: `${screenshots}/published-desktop.png`,
    fullPage: true,
  });

  // Editing a published workflow starts a new draft and version; the published one stays.
  await page.getByRole('button', { name: 'Edit as new draft' }).click();
  await page.getByText(/^Editing custom-.* · from version 1\.0\.0$/).waitFor();
  expect(await page.getByLabel('Version', { exact: true }).inputValue()).toBe(
    '1.1.0',
  );
  await page.getByRole('button', { name: 'Discard' }).click();
  await page.getByRole('button', { name: 'Discard draft' }).click();
  await page.getByRole('heading', { name: 'Workflows', level: 1 }).waitFor();

  // Narrow screens keep the gallery usable and show code read-only.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/app/${tenantId}/workflows/new`);
  await page.getByRole('heading', { name: 'Replenish low stock' }).waitFor();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: `${screenshots}/gallery-mobile.png`,
    fullPage: true,
  });
  await page.goto(`/app/${tenantId}/workflows`);
  await page
    .getByRole('link', { name: /Replenish low stock \(custom\)/ })
    .click();
  // On small screens, steps are added from a sheet at the chosen place.
  await page.getByText('Ready to publish').waitFor();
  await page.getByRole('button', { name: 'Add a step after step 1' }).click();
  const sheet = page.getByRole('dialog', { name: 'Add a step' });
  await sheet.getByText('The step is added after step 1.').waitFor();
  await page.screenshot({
    path: `${screenshots}/builder-sheet-mobile.png`,
    animations: 'disabled',
  });
  await page.keyboard.press('Escape');
  await sheet.waitFor({ state: 'hidden' });
  await page.screenshot({
    path: `${screenshots}/builder-mobile.png`,
    fullPage: true,
  });
  await page.getByRole('tab', { name: 'Code' }).click();
  await page
    .getByText(
      'Code is read-only on small screens. Use a wider screen to edit it.',
    )
    .waitFor();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: `${screenshots}/code-mobile.png`,
    fullPage: true,
  });
  expect(errors).toEqual([]);
});

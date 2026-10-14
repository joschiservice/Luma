/* global document, window */
import { randomUUID } from 'node:crypto';

import { expect, test } from './browser-fixtures.mjs';
import { availablePort, startProcess } from './helpers.mjs';
import { inboxFixture, splitDelivery } from './inbox-fixture.mjs';

/** Opens a browser context signed in with an API session cookie. */
async function signedIn(t, origin, cookie, options = {}) {
  const context = await t.newContext({
    baseURL: origin,
    viewport: { width: 1440, height: 1000 },
    ...options,
  });
  await context.addCookies(
    cookie.split('; ').map((value) => {
      const [name, ...rest] = value.split('=');

      return { name, value: rest.join('='), url: origin };
    }),
  );
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);

  return page;
}

const fitsViewport = (page) =>
  page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth,
  );

test('works supplier and customer threads, documents, replies and mailbox rules', async ({
  resources: t,
}) => {
  const port = await availablePort();
  const f = await inboxFixture(t, `http://127.0.0.1:${port}`);
  const web = startProcess(
    t,
    'e2e/web-server.mjs',
    { TEST_API_ORIGIN: f.apiOrigin, TEST_WEB_PORT: String(port) },
    true,
  );
  await web.message('listening');

  // A supplier's split delivery for a tracked purchase order and a customer asking about an order.
  const { summary: supplierThread, order, reference } = await splitDelivery(f);
  const customer = await f.scenario('customer-delay-mail');
  const orderName = customer.resources.find(
    (item) => item.kind === 'Order',
  ).label;
  let documentId;
  await f.readUntil(async () => {
    const threads = (await f.threads()).items;
    const detail = await f.thread(supplierThread.id);
    documentId = detail.documents.find(
      (item) => item.mimeType === 'text/csv' && item.state === 'ready',
    )?.id;

    return (
      documentId && threads.some((item) => item.subject.includes(orderName))
    );
  }, 'both threads and the delivery schedule');

  const page = await signedIn(t, f.origin, f.operator);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const inboxPath = `/app/${f.org}/inbox`;

  // Navigation: the sidebar and the G then E shortcut both open the inbox.
  await page.goto(`/app/${f.org}`);
  await page.getByRole('link', { name: 'Inbox', exact: true }).first().click();
  await page.waitForURL(`**${inboxPath}**`);
  await expect(page.getByRole('heading', { name: 'Inbox' })).toBeVisible();
  await page.goto(`/app/${f.org}`);
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('g');
  await page.keyboard.press('e');
  await page.waitForURL(`**${inboxPath}**`);

  // The list shows both threads with their counts.
  const views = page.getByRole('tablist', { name: 'Thread views' });
  await expect(views.getByRole('tab', { name: /Open/ })).toContainText('2');
  await expect(views.getByRole('tab', { name: /Unassigned/ })).toContainText(
    '2',
  );
  const rows = page
    .getByRole('list')
    .filter({ has: page.locator('#thread-' + supplierThread.id) });
  await expect(rows.getByRole('link')).toHaveCount(2);

  // J focuses the first thread, Space opens it, and J and K move the open thread.
  await page.keyboard.press('j');
  await page.keyboard.press('Space');
  await expect(page).toHaveURL(/thread=/);
  const first = new URL(page.url()).searchParams.get('thread');
  await page.keyboard.press('j');
  await expect(page).not.toHaveURL(new RegExp(`thread=${first}`));
  await page.keyboard.press('k');
  await expect(page).toHaveURL(new RegExp(`thread=${first}`));
  await expect(page.locator(`#thread-${first}`)).toHaveAttribute(
    'aria-current',
    'page',
  );

  // The supplier thread: messages, linked records and thread work.
  await page.goto(`${inboxPath}?view=all&thread=${supplierThread.id}`);
  const detail = page.getByRole('region', { name: 'Selected thread' });
  await expect(
    detail.getByRole('heading', { name: supplierThread.subject }),
  ).toBeVisible();
  await expect(detail.getByText('2 messages').first()).toBeVisible();
  await expect(
    detail.getByRole('link', { name: `Purchase order ${reference}` }).first(),
  ).toBeVisible();
  await expect(
    detail.getByRole('link', { name: /^Supplier / }).first(),
  ).toBeVisible();
  const work = detail.getByRole('region', { name: 'Thread work' });
  await work.getByRole('combobox', { name: 'Assign…' }).click();
  const picker = page.getByRole('listbox', { name: 'Assign thread' });
  await picker.getByRole('option', { name: /^You/ }).click();
  await expect(page.locator(`#thread-${supplierThread.id}`)).toContainText(
    'Owner: You',
  );
  await expect(
    work.getByRole('combobox', { name: 'Change owner…' }),
  ).toBeVisible();

  const note = `Call the supplier about the rest ${randomUUID().slice(0, 8)}`;
  const notes = detail.getByRole('region', { name: 'Internal notes' });
  await expect(notes.getByText('Internal — never sent')).toBeVisible();
  await notes.getByPlaceholder(/Write a note for your team/).fill(note);
  await notes.getByRole('button', { name: 'Add note' }).click();
  await expect(notes.getByText(note)).toBeVisible();

  const due = new Date(Date.now() + 2 * 86_400_000);
  const local = `${due.getFullYear()}-${String(due.getMonth() + 1).padStart(2, '0')}-${String(due.getDate()).padStart(2, '0')}T09:30`;
  await work.locator('input[type="datetime-local"]').fill(local);
  await work.getByRole('button', { name: 'Set deadline' }).click();
  await expect(work.getByText(/set by a person/)).toBeVisible();
  const timeline = detail.getByRole('region', { name: 'Timeline' });
  // The timeline is collapsed by default; the note is recorded there.
  await expect(timeline.getByText('Internal note added')).toBeAttached();

  // A draft reply cites the purchase order it restates.
  const reply = detail.getByRole('region', { name: 'Reply' });
  await reply.getByRole('button', { name: 'Draft reply' }).click();
  await expect(reply.getByText('Sources')).toBeVisible();
  await expect(
    reply.getByText(`Purchase order ${reference}`).first(),
  ).toBeVisible();
  await expect(
    reply.getByText(/Current|Older than a day|Couldn’t be read/).first(),
  ).toBeVisible();

  await page.emulateMedia({ colorScheme: 'dark' });
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.classList.contains('dark')),
    )
    .toBe(true);
  await page.screenshot({
    path: test.info().outputPath('inbox-thread-dark.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await page.emulateMedia({ colorScheme: 'light' });
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.classList.contains('dark')),
    )
    .toBe(false);
  await page.screenshot({
    path: test.info().outputPath('inbox-thread-light.png'),
    fullPage: true,
    animations: 'disabled',
  });

  // The purchase order shows the thread under Inbox threads.
  await page.goto(`/app/${f.org}/procurement/${order.id}`);
  const panel = page.getByRole('region', { name: 'Inbox threads' });
  await expect(panel.getByText(supplierThread.subject)).toBeVisible();

  // Document review: facts beside the source; selecting one highlights its cells.
  await page.goto(`/app/${f.org}/inbox/documents/${documentId}`);
  await expect(
    page.getByRole('heading', { name: `Lieferplan-${reference}.csv` }),
  ).toBeVisible();
  const source = page.getByRole('table', { name: /^Sheet / });
  await expect(source).toBeVisible();
  const facts = page.getByRole('region', { name: /facts?$/ });
  const fact = facts.getByRole('button', { name: /Show in document/ }).first();
  await expect(fact).toHaveAttribute('aria-pressed', 'false');
  await fact.click();
  await expect(fact).toHaveAttribute('aria-pressed', 'true');
  await expect(source.locator('[data-selected]').first()).toBeVisible();
  await expect(facts.getByText('From table columns').first()).toBeVisible();

  // Mailbox settings list the rules and add a sender-domain rule.
  await page.goto(`/app/${f.org}/inbox/settings`);
  const rules = page.getByRole('region', { name: 'What Luma reads' });
  await expect(rules.getByText('orders1@supplier.example')).toBeVisible();
  await expect(rules.getByText('customer.example')).toBeVisible();
  await rules.getByRole('button', { name: 'Add rule' }).click();
  const form = page.getByRole('form', { name: 'Add rule' });
  await form.getByLabel('Value').fill('freight.example');
  // New rules default to a supplier; a carrier's domain is another correspondent.
  await form.getByRole('combobox', { name: 'Correspondent' }).click();
  await page.getByRole('option', { name: 'Other', exact: true }).click();
  await form.getByRole('button', { name: 'Add rule' }).click();
  await expect(rules.getByText('freight.example')).toBeVisible();
  expect(
    (await f.messaging('/mailboxes')).items[0].rules.some(
      (rule) =>
        rule.kind === 'sender_domain' && rule.value === 'freight.example',
    ),
  ).toBe(true);

  // Narrow screens stack the panes: an open thread replaces the list.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${inboxPath}?view=all&thread=${supplierThread.id}`);
  await expect(
    detail.getByRole('heading', { name: supplierThread.subject }),
  ).toBeVisible();
  await expect(page.locator(`#thread-${supplierThread.id}`)).toBeHidden();
  expect(await fitsViewport(page)).toBe(true);
  await page.screenshot({
    path: test.info().outputPath('inbox-thread-narrow.png'),
    fullPage: true,
    animations: 'disabled',
  });
  // Esc inside the thread returns to the list and focuses the thread's row.
  await detail.getByRole('button', { name: 'Close panel' }).focus();
  await page.keyboard.press('Escape');
  await expect(page.locator(`#thread-${supplierThread.id}`)).toBeVisible();
  await expect(page.locator(`#thread-${supplierThread.id}`)).toBeFocused();
  expect(await fitsViewport(page)).toBe(true);
  await page.setViewportSize({ width: 1440, height: 1000 });

  // Empty views say so; loading and unavailable states are labelled.
  await page.goto(`${inboxPath}?view=closed`);
  await expect(page.getByText('No closed threads')).toBeVisible();
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  await page.route('**/messaging/threads?*', async (route) => {
    await held;
    await route.continue();
  });
  await page.goto(`${inboxPath}?view=open`);
  await expect(
    page.getByRole('status').getByText('Loading threads'),
  ).toBeAttached();
  release();
  await expect(page.locator(`#thread-${supplierThread.id}`)).toBeVisible();
  await page.unroute('**/messaging/threads?*');
  await page.route('**/messaging/threads?*', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ code: 'UNAVAILABLE', message: 'Unavailable' }),
    }),
  );
  await page.goto(`${inboxPath}?view=open`);
  await expect(page.getByText('Threads couldn’t be loaded')).toBeVisible();
  await expect(
    page.getByText('The inbox is temporarily unavailable'),
  ).toBeVisible();
  await page.unroute('**/messaging/threads?*');

  // A workspace without a mailbox is asked to connect one.
  const outsider = await f.join('Newshop');
  const other = await f.request(
    '/v1/organizations',
    {
      name: 'New shop',
      slug: `new-${randomUUID().slice(0, 8)}`,
      dataRegion: 'AU',
    },
    { cookie: outsider.cookie, status: 201 },
  );
  const empty = await signedIn(t, f.origin, outsider.cookie);
  await empty.goto(`/app/${other.id}/inbox`);
  await expect(
    empty.getByRole('heading', { name: 'Connect a mailbox' }),
  ).toBeVisible();
  await expect(
    empty.getByRole('link', { name: 'Connect Gmail in Apps' }),
  ).toBeVisible();

  expect(errors).toEqual([]);
});

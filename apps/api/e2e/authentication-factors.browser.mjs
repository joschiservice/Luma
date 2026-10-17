/* global document, innerWidth */
import { createHmac } from 'node:crypto';

import { expect, test } from './browser-fixtures.mjs';
import {
  availablePort,
  createAccount,
  database,
  startApi,
  startProcess,
} from './helpers.mjs';

const password = 'browser-test-password-123';

/** Computes the current RFC 6238 code for a base32 setup key, as an authenticator app would. */
function totp(setupKey) {
  let bits = '';
  for (const character of setupKey.replace(/\s/g, ''))
    bits += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
      .indexOf(character)
      .toString(2)
      .padStart(5, '0');
  const key = Buffer.from(
    bits.match(/.{8}/g).map((byte) => Number.parseInt(byte, 2)),
  );
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const digest = createHmac('sha1', key).update(counter).digest();
  const offset = digest[digest.length - 1] & 15;

  return String(
    (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000,
  ).padStart(6, '0');
}

async function fixture(t) {
  const port = await availablePort();
  // WebAuthn relying-party IDs must be domains, so this journey uses localhost.
  const origin = `http://localhost:${port}`;
  const db = await database(t);
  await db.migrate();
  await db.grantRuntime();
  const api = await startApi(t, db, origin);
  const web = startProcess(
    t,
    'e2e/web-server.mjs',
    { TEST_API_ORIGIN: api.origin, TEST_WEB_PORT: String(port) },
    true,
  );
  await web.message('listening');
  const context = await t.newContext({
    baseURL: origin,
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.setDefaultTimeout(15_000);
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send(
    'WebAuthn.addVirtualAuthenticator',
    {
      options: {
        protocol: 'ctap2',
        transport: 'internal',
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    },
  );

  return { db, page, errors, cdp, authenticatorId };
}

async function heading(page, name) {
  try {
    await page.getByRole('heading', { name, exact: true }).waitFor();
  } catch (cause) {
    throw new Error(
      `${page.url()}\n${await page.locator('body').innerText()}`,
      { cause },
    );
  }
}

async function signInWithPassword(page) {
  await heading(page, 'Sign in to Luma');
  await page.getByLabel('Email', { exact: true }).fill('grace@example.test');
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

test('protects sign-in with an authenticator app and signs in with a passkey', async ({
  resources: t,
}) => {
  const { db, page, errors, cdp, authenticatorId } = await fixture(t);
  await createAccount(page, db, {
    name: 'Grace',
    email: 'grace@example.test',
    password,
  });
  await heading(page, 'Create a workspace');
  await page.getByLabel('Workspace name').fill('Harbor Goods');
  await page
    .getByRole('button', { name: 'Create workspace', exact: true })
    .click();
  await heading(page, 'Needs you');
  const organizationId = new URL(page.url()).pathname.split('/')[2];
  const security = `/app/${organizationId}/settings/security`;

  await page.goto(security);
  await heading(page, 'Authenticator app');
  await page.getByRole('button', { name: 'Set up', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Password').fill('not-the-password');
  await dialog.getByRole('button', { name: 'Continue' }).click();
  await expect(dialog.getByRole('alert')).toHaveText(
    'That password isn’t correct.',
  );
  await dialog.getByLabel('Password').fill(password);
  await dialog.getByRole('button', { name: 'Continue' }).click();
  const codeList = dialog.getByRole('list', { name: 'Backup codes' });
  await expect(codeList.getByRole('listitem')).toHaveCount(10);
  const codes = await codeList.getByRole('listitem').allInnerTexts();
  expect(codes).toHaveLength(10);
  await dialog.getByRole('button', { name: 'I’ve saved my codes' }).click();
  await expect(
    dialog.getByRole('img', { name: 'QR code for your authenticator app' }),
  ).toBeVisible();
  const setupKey = await dialog.getByLabel('Setup key').innerText();
  await dialog.getByLabel('Authentication code').fill(totp(setupKey));
  await dialog.getByRole('button', { name: 'Turn on' }).click();
  await expect(dialog).toBeHidden();
  await expect(
    page.getByText('Two-factor authentication is on', { exact: true }),
  ).toBeVisible();

  await page.goto('/sign-out');
  await signInWithPassword(page);
  await heading(page, 'Confirm it’s you');
  await page.getByLabel('Authentication code').fill('000000');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('status')).toHaveText(
    'That code didn’t work. Check your authenticator app and try again.',
  );
  await page.getByRole('button', { name: 'Use a backup code' }).click();
  await page.getByLabel('Backup code').fill(codes[0]);
  await page.getByRole('button', { name: 'Verify' }).click();
  await heading(page, 'Needs you');

  // A used backup code cannot open another session.
  await page.goto('/sign-out');
  await signInWithPassword(page);
  await page.getByRole('button', { name: 'Use a backup code' }).click();
  await page.getByLabel('Backup code').fill(codes[0]);
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByRole('status')).toHaveText(
    'That backup code didn’t work. Each code works once.',
  );
  await page
    .getByRole('button', { name: 'Use your authenticator app' })
    .click();
  await page.getByLabel('Authentication code').fill(totp(setupKey));
  await page.getByRole('button', { name: 'Verify' }).click();
  await heading(page, 'Needs you');

  await page.goto(security);
  await heading(page, 'Authenticator app');
  await expect(page.getByText('None added')).toBeVisible();
  await page.getByLabel('Name (optional)').fill('Test authenticator');
  await page.getByRole('button', { name: 'Add passkey' }).click();
  await expect(page.getByText('Passkey added.')).toBeVisible();
  const passkeys = page.getByRole('list', { name: 'Your passkeys' });
  await expect(passkeys.getByText('Test authenticator')).toBeVisible();
  const { credentials } = await cdp.send('WebAuthn.getCredentials', {
    authenticatorId,
  });
  expect(credentials).toHaveLength(1);
  expect(credentials[0].rpId).toBe('localhost');

  // A passkey replaces both the password and the code step.
  await page.goto('/sign-out');
  await heading(page, 'Sign in to Luma');
  await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
  await heading(page, 'Needs you');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(security);
  await heading(page, 'Authenticator app');
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.getByRole('button', { name: 'Remove Test authenticator' }).focus();
  await page.keyboard.press('Enter');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Remove passkey' })
    .click();
  await expect(page.getByText('Test authenticator removed.')).toBeVisible();
  await expect(
    page.getByText('No passkeys yet.', { exact: false }),
  ).toBeVisible();
  const stored = await db.owner.query(
    'SELECT count(*)::int AS count FROM passkeys',
  );
  expect(stored.rows[0].count).toBe(0);

  await page.getByRole('button', { name: 'Turn off', exact: true }).click();
  await page.getByRole('dialog').getByLabel('Password').fill(password);
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Turn off' })
    .click();
  await expect(page.getByText('Not set up', { exact: true })).toBeVisible();

  // Every factor change and sign-in step appears once, newest first.
  const events = await db.owner.query(
    "SELECT e.event_type,e.outcome,e.reason_code FROM account_security_events e JOIN users u ON u.id=e.user_id WHERE u.email='grace@example.test' ORDER BY e.created_at,e.id",
  );
  expect(
    events.rows.map((row) =>
      [row.event_type, row.outcome, row.reason_code].join(' '),
    ),
  ).toEqual([
    // The first sign-in after confirming the new account's email address.
    'sign-in.password succeeded ',
    'two-factor.enabled succeeded ',
    'sign-in.password succeeded second-factor-required',
    'sign-in.two-factor failed invalid-code',
    'sign-in.two-factor succeeded backup-code',
    'sign-in.password succeeded second-factor-required',
    'sign-in.two-factor failed invalid-code',
    'sign-in.two-factor succeeded authenticator-code',
    'passkey.added succeeded ',
    'sign-in.passkey succeeded ',
    'passkey.removed succeeded ',
    'two-factor.disabled succeeded ',
  ]);
  const activity = page.getByRole('list', { name: 'Security activity' });
  await expect(activity.getByRole('listitem').first()).toContainText(
    'Two-factor authentication turned off',
  );
  await expect(activity.getByRole('listitem')).toHaveCount(12);
  await expect(activity.getByText('Code entry failed')).toHaveCount(2);
  await expect(
    activity.getByText('Signed in with a passkey', { exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await activity.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: test.info().outputPath('security-activity-light-narrow.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({
    path: test.info().outputPath('security-activity-dark.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await page.emulateMedia({ colorScheme: 'light' });

  await page.goto('/sign-out');
  await signInWithPassword(page);
  await heading(page, 'Needs you');
  expect(errors).toEqual([]);
});

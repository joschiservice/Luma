// Drives a deployed customer app through account creation, email confirmation, workspace
// creation and an accepted invitation, reading the real confirmation and invitation mail from
// the S3 bucket SES stores `inbox.<domain>` mail in. The deploy workflow runs it after each
// staging deploy with `pnpm test:smoke`; normal test suites never pick it up.
//
// Environment: SMOKE_BASE_URL (the customer app), SMOKE_INBOX_DOMAIN, SMOKE_INBOX_BUCKET and
// AWS credentials that may list and read that bucket; optional SMOKE_RUN_ID.
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';

import { chromium } from 'playwright';

import { messageLinks, messageRecipients } from './mail.mjs';

const run = promisify(execFile);
const mailTimeoutMs = 3 * 60_000;

/**
 * Returns a required environment variable or throws naming it.
 * @param {string} name
 */
function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);

  return value;
}

const origin = new URL(required('SMOKE_BASE_URL')).origin;
const inboxDomain = required('SMOKE_INBOX_DOMAIN');
const bucket = required('SMOKE_INBOX_BUCKET');
const runId = process.env.SMOKE_RUN_ID || randomBytes(6).toString('hex');
if (!/^[a-z0-9-]{1,40}$/.test(runId))
  throw new Error('SMOKE_RUN_ID must be 1-40 lowercase letters, digits or -');
const started = new Date(Date.now() - 60_000).toISOString();
const artifacts = new URL('../../.luma/smoke/', import.meta.url);

/**
 * A synthetic account with a fresh random password.
 * @param {string} name
 * @param {string} email
 */
function person(name, email) {
  return { name, email, password: randomBytes(24).toString('base64url') };
}

const owner = person('Smoke Owner', `smoke+${runId}@${inboxDomain}`);
const teammate = person('Smoke Teammate', `smoke+${runId}-b@${inboxDomain}`);

/**
 * Logs a journey step. Links and passwords are never logged.
 * @param {string} message
 */
function step(message) {
  console.log(`smoke: ${message}`);
}

/**
 * Polls the inbox bucket for a message to `recipient` that carries a link on the app's origin
 * matching `wanted`, and returns that link. Gives up after three minutes.
 * @param {string} recipient
 * @param {(url: URL) => boolean} wanted
 */
async function waitForLink(recipient, wanted) {
  const deadline = Date.now() + mailTimeoutMs;
  const seen = new Set();
  const directory = await mkdtemp(join(tmpdir(), 'luma-smoke-'));
  try {
    while (Date.now() < deadline) {
      const { stdout } = await run('aws', [
        's3api',
        'list-objects-v2',
        '--bucket',
        bucket,
        '--query',
        `Contents[?LastModified>='${started}'].Key`,
        '--output',
        'json',
      ]);
      /** @type {string[]} */
      const keys = JSON.parse(stdout) ?? [];
      for (const key of keys) {
        if (seen.has(key)) continue;
        seen.add(key);
        const file = join(directory, 'message.eml');
        await run('aws', [
          's3api',
          'get-object',
          '--bucket',
          bucket,
          '--key',
          key,
          file,
        ]);
        const raw = await readFile(file, 'utf8');
        if (!messageRecipients(raw).includes(recipient)) continue;
        const link = messageLinks(raw, origin).find(wanted);
        if (link) return link;
      }
      await sleep(5000);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  throw new Error(`No expected message reached ${recipient} within 3 minutes`);
}

/**
 * Waits for a heading with exactly this name.
 * @param {import('playwright').Page} page
 * @param {string} name
 */
async function heading(page, name) {
  await page.getByRole('heading', { name, exact: true }).waitFor();
}

/**
 * Creates an account in the AU region, opens the confirmation link from its mail and signs in.
 * @param {import('playwright').Page} page
 * @param {ReturnType<typeof person>} account
 */
async function register(page, account) {
  step(`creating ${account.email}`);
  await page.goto('/sign-up');
  await page.getByRole('radio', { name: /Australia/ }).check();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill(account.name);
  await page.getByLabel('Email', { exact: true }).fill(account.email);
  await page.getByLabel('Password', { exact: true }).fill(account.password);
  await page
    .getByRole('button', { name: 'Create account', exact: true })
    .click();
  await heading(page, 'Check your email');

  step(`confirming ${account.email}`);
  const confirmation = await waitForLink(
    account.email,
    (url) => url.pathname === '/verify-email' && url.hash.length > 1,
  );
  await page.goto(confirmation.href);
  await page
    .getByText('Your email address is confirmed. Sign in to continue.')
    .waitFor();

  await page.goto('/sign-in');
  await page.getByLabel('Email', { exact: true }).fill(account.email);
  await page.getByLabel('Password', { exact: true }).fill(account.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await heading(page, 'Create a workspace');
}

/**
 * Opens the workspace's Team settings through the settings navigation.
 * @param {import('playwright').Page} page
 * @param {string} organizationId
 */
async function openTeam(page, organizationId) {
  await page.goto(`/app/${organizationId}/settings/workspace`);
  await page
    .getByRole('navigation', { name: 'Settings sections' })
    .getByRole('link', { name: 'Team', exact: true })
    .click();
}

const browser = await chromium.launch({ headless: true });
/** @type {Map<string, import('playwright').Page>} */
const pages = new Map();
let organizationId = '';
let joined = false;
let failed = false;

/** Opens a page in its own browser context, so each person has their own session. */
async function open(/** @type {string} */ name) {
  const context = await browser.newContext({
    baseURL: origin,
    locale: 'en-US',
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  pages.set(name, page);

  return page;
}

try {
  const ownerPage = await open('owner');
  await register(ownerPage, owner);

  step('creating a workspace');
  await ownerPage.getByLabel('Workspace name').fill(`Smoke ${runId}`);
  await ownerPage
    .getByRole('button', { name: 'Create workspace', exact: true })
    .click();
  await heading(ownerPage, 'Needs you');
  organizationId = new URL(ownerPage.url()).pathname.split('/')[2] ?? '';

  step(`inviting ${teammate.email}`);
  await openTeam(ownerPage, organizationId);
  await ownerPage.getByRole('button', { name: 'Invite teammate' }).click();
  await ownerPage.getByLabel('Email address').fill(teammate.email);
  await ownerPage
    .getByRole('button', { name: 'Send invitation', exact: true })
    .click();
  await ownerPage
    .getByText('Invitation queued. Access starts when they accept.')
    .waitFor();

  const teammatePage = await open('teammate');
  await register(teammatePage, teammate);

  step('accepting the invitation');
  const invitation = await waitForLink(teammate.email, (url) =>
    url.pathname.startsWith(`/app/invitations/${organizationId}/`),
  );
  await teammatePage.goto(invitation.href);
  await teammatePage.getByRole('button', { name: 'Accept invitation' }).click();
  await teammatePage.waitForURL(`**/app/${organizationId}/home*`);
  joined = true;

  step('checking the membership from the owner');
  await openTeam(ownerPage, organizationId);
  await ownerPage
    .getByRole('button', { name: `Manage ${teammate.name}` })
    .waitFor();
  step('passed');
} catch (error) {
  failed = true;
  console.error(error);
  // Screenshots show only the synthetic smoke accounts.
  await mkdir(artifacts, { recursive: true });
  for (const [name, page] of pages)
    await page
      .screenshot({
        path: new URL(`${name}.png`, artifacts).pathname,
        fullPage: true,
      })
      .catch(() => undefined);
} finally {
  // Customers cannot delete their accounts or close workspaces; staff erase smoke accounts.
  // Cleanup removes the shared access and ends both sessions, and fails the run if it can't.
  try {
    const ownerPage = pages.get('owner');
    const teammatePage = pages.get('teammate');
    if (joined && ownerPage) {
      step('removing the teammate');
      await openTeam(ownerPage, organizationId);
      await ownerPage
        .getByRole('button', { name: `Manage ${teammate.name}` })
        .click();
      await ownerPage.getByRole('button', { name: 'Remove access' }).click();
      await ownerPage.getByText('Workspace access removed.').waitFor();
    }
    for (const page of [teammatePage, ownerPage])
      if (page) {
        await page.goto('/sign-out');
        await heading(page, 'Sign in to Luma');
      }
  } catch (error) {
    failed = true;
    console.error('smoke: cleanup failed', error);
  }
  await browser.close();
}
if (failed) process.exitCode = 1;

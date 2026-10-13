import { buildApp, createApplicationServices } from '@luma/application-runtime';
import { registerIdentityHttp } from '@luma/identity/http';
import {
  createModelGateway,
  createObservability,
  createTenantDatabase,
} from '@luma/platform/composition';
import pg from 'pg';

import { expect, test } from './browser-fixtures.mjs';
import { fulfillmentFixture } from './fulfillment-fixture.mjs';
import { availablePort, startProcess } from './helpers.mjs';
import { settingsFixture } from './settings-fixture.mjs';

// Only the model response is scripted. Context lookup, permissions, source facts, citations,
// tenant release checks and the API are the real application path over disposable data.
test('explains a record beside its page and preserves exact chart selection', async ({
  resources: t,
}) => {
  const port = await availablePort(),
    origin = `http://127.0.0.1:${port}`;
  const f = await settingsFixture(t, origin);
  const work = await fulfillmentFixture(t, f);
  const model = 'eu.anthropic.claude-sonnet-4-5-20250929-v1:0';
  const observability = createObservability({
    environment: 'test',
    release: 'test',
    sampleRate: 0,
    approvedModels: [model],
  });
  let released = false;
  observability.flag = async (_context, flag) =>
    flag === 'contextual-record-assistance' && released;
  const modelRequests = [];
  const gateway = createModelGateway(
    {
      routes: {
        assistant: {
          adapter: 'bedrock-eu',
          model,
          providers: ['bedrock'],
          zeroDataRetention: true,
        },
      },
      timeoutMs: 30000,
    },
    observability,
    {
      bedrockEu: {
        region: 'EU',
        supportsZeroDataRetention: true,
        async generate(_route, request) {
          modelRequests.push(request);
          const read = request.messages.findLast((message) =>
            message.content.startsWith('Current contextual read'),
          );
          const marker = /\[\[(?:order|fulfillment):[a-f0-9-]+\]\]/.exec(
            read?.content ?? '',
          )?.[0];
          if (!marker) throw new Error('Context was not read before answering');

          return {
            text: `The source reports incomplete fulfillment ${marker}. This is an observation, not an independently verified outcome. Open the cited record to review its governed next steps.`,
            toolCalls: [],
            usage: { inputTokens: 100, outputTokens: 50, costUsd: null },
          };
        },
      },
    },
  );
  const pool = new pg.Pool({ connectionString: f.db.runtimeUrl });
  const application = createApplicationServices({
    database: createTenantDatabase(pool),
    identity: f.identity.service,
    execution: { kind: 'disabled' },
    modelGateway: gateway,
    assistant: { available: true, reason: null },
    observability,
  });
  const app = await buildApp(
    {},
    {
      ...application.http,
      identity: f.identity.service,
      settings: f.identity.settings,
      roles: f.identity.roles(),
      trustedOrigins: [origin],
    },
  );
  registerIdentityHttp(app, f.identity);
  t.onTestFinished(async () => {
    await app.close();
    await pool.end();
    await observability.shutdown();
  });
  const apiOrigin = await app.listen({ host: '127.0.0.1', port: 0 });
  await startProcess(
    t,
    'e2e/web-server.mjs',
    { TEST_API_ORIGIN: apiOrigin, TEST_WEB_PORT: String(port) },
    true,
  ).message('listening');
  const browser = await t.newContext({
    baseURL: origin,
    viewport: { width: 1440, height: 1000 },
  });
  await browser.addCookies(
    f.member.cookie.split('; ').map((value) => {
      const [name, ...rest] = value.split('=');

      return { name, value: rest.join('='), url: origin };
    }),
  );
  const page = await browser.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`/app/${f.org.id}/fulfillment/${work.ids.held}`);
  await page.getByRole('heading', { level: 1, name: /#200/ }).waitFor();
  await expect(
    page.getByRole('button', { name: 'Explain with Luma' }),
  ).toHaveCount(0);
  released = true;
  await page.reload();
  await page.getByRole('button', { name: 'Explain with Luma' }).click();
  const panel = page.getByRole('complementary', { name: 'Ask Luma' });
  await expect(panel).toContainText('Investigating:');
  await panel.getByRole('button', { name: 'Ask', exact: true }).click();
  await expect(panel).toContainText('not an independently verified outcome');
  await expect(panel.getByRole('heading', { name: 'Sources' })).toBeVisible();
  await expect(panel.locator('.assistant-source-time')).toHaveCount(1);
  expect(modelRequests[0].messages.at(-1).content).toContain(work.ids.held);
  await page.screenshot({ path: '/tmp/luma109-record-light.png' });

  await page.goto(
    `/app/${f.org.id}/insights?range=7d&chart=fulfillment&series=held`,
  );
  const sheet = page.getByRole('dialog');
  await sheet.getByRole('heading', { name: /Open fulfillments/ }).waitFor();
  await sheet.getByRole('button', { name: 'Explain with Luma' }).click();
  await expect(sheet).toHaveCount(0);
  await panel.getByRole('button', { name: 'Ask', exact: true }).click();
  await expect(panel).toContainText('not an independently verified outcome');
  const navigation = modelRequests
    .at(-1)
    .messages.find((message) => message.content.includes('Navigation context'));
  expect(navigation.content).toContain('"range":"7d"');
  expect(navigation.content).toContain('"series":"held"');
  expect(navigation.content).toContain('"asOf":');
  await page.evaluate(() =>
    globalThis.document.documentElement.classList.add('dark'),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: '/tmp/luma109-chart-dark-narrow.png' });
  expect(errors).toEqual([]);
});

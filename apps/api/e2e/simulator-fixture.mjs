import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { defaultConfiguration } from '@luma/exceptions';

import { demoDetection } from '../../../tooling/simulator/demo.mjs';
import { createSimulatorEnvironment } from '../../../tooling/simulator/e2e-environment.mjs';
import { database, secret } from './helpers.mjs';

/**
 * Journeys let a stock gap wait one second for provider sync instead of 30 minutes, so they
 * exercise the wait with a few detection passes.
 */
const journeyConfiguration = {
  ...defaultConfiguration,
  version: `${defaultConfiguration.version}-journey`,
  thresholds: { ...defaultConfiguration.thresholds, propagationSeconds: 1 },
};

/** Provisions and cleans an isolated database-backed simulator workspace for platform tests. */
export async function setupSimulator(
  t,
  {
    temporal,
    origin = 'http://127.0.0.1:3000',
    profile = 'test',
    erp,
    historyDays,
    chaos = 'calm',
    detection,
    demo,
  } = {},
) {
  const db = await database(t);
  await db.migrate();
  await db.grantRuntime();
  const role = new URL(db.runtimeUrl).username;
  await db.owner.query(
    `GRANT luma_exceptions,luma_connectors,luma_inventory,luma_orders,luma_customers,luma_commerce_sync TO "${role}"`,
  );
  const directory = await mkdtemp(join(tmpdir(), 'luma-operations-e2e-'));
  t.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const fixture = await createSimulatorEnvironment({
    t,
    directory,
    temporal,
    profile,
    erp,
    historyDays,
    chaos,
    // A journey's own configuration wins; demo workspaces keep their other demo timings.
    detection: {
      ...(demo?.detection === 'demo'
        ? demoDetection(journeyConfiguration)
        : { configuration: journeyConfiguration }),
      ...detection,
    },
    demo,
    env: {
      IDENTITY_DATABASE_URL: db.runtimeUrl,
      WORKFLOW_DATABASE_URL: db.runtimeUrl,
      BETTER_AUTH_SECRET: secret,
      BETTER_AUTH_URL: origin,
      CONNECTIONS_ACTIVE_KEY_ID: 'test',
      CONNECTIONS_KEYS: JSON.stringify({
        test: randomBytes(32).toString('base64'),
      }),
    },
    saved: { seedPassword: randomUUID() },
  });
  t.onTestFinished(async () => {
    try {
      if (!(t.failed ?? t.task?.result?.state === 'fail')) return;
      const path = join(
        tmpdir(),
        `luma-operations-failure-${fixture.manifest.runId}.json`,
      );
      const actor = await fixture.pilot.operator();
      const incidents = await fixture.pilot.detection.exceptions.list(actor);
      await writeFile(
        path,
        JSON.stringify(
          {
            runs: await Promise.all(
              (await fixture.call('runs')).map(async ({ id }) => {
                const run = await fixture.call(`runs/${id}`);
                const entries = [];
                let before;
                do {
                  const page = await fixture.call(
                    `runs/${id}/journal${before ? `?before=${before}` : ''}`,
                  );
                  entries.push(...page.items);
                  before = page.nextCursor;
                } while (before && entries.length < 5_000);

                return {
                  ...run,
                  journal: entries.reverse(),
                  incidents: await fixture.call(`runs/${id}/incidents`),
                };
              }),
            ),
            incidents,
            evidence: await Promise.all(
              incidents.map((incident) =>
                fixture.pilot.detection.exceptions.evidence(actor, incident.id),
              ),
            ),
          },
          null,
          2,
        ),
      );
      await t.attach?.('simulator-evidence', {
        path,
        contentType: 'application/json',
      });
      console.error(`Simulator failure evidence: ${path}`);
    } finally {
      await fixture.close();
    }
  });

  return { ...fixture, db };
}

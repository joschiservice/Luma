import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createTenantFeatureRelease } from '@luma/application-runtime';
import { defaultConfiguration } from '@luma/exceptions';
import { featureFlags } from '@luma/platform';
import { Pool } from 'pg';

import {
  copySimulatorDatabase,
  provisionSimulatorDatabase,
} from '../../../tooling/simulator/database.mjs';
import { demoDetection } from '../../../tooling/simulator/demo.mjs';
import { createSimulatorEnvironment } from '../../../tooling/simulator/e2e-environment.mjs';
import { database, runtimeRoles, secret } from './helpers.mjs';
import { preparedSnapshot, scenarioName } from './scenario-snapshots.mjs';

/**
 * Journeys let a stock gap wait one second for provider sync instead of 30 minutes, so they
 * exercise the wait with a few detection passes.
 */
const journeyConfiguration = {
  ...defaultConfiguration,
  version: `${defaultConfiguration.version}-journey`,
  thresholds: {
    ...defaultConfiguration.thresholds,
    propagationSeconds: 1,
    oversellPropagationSeconds: 1,
  },
};

/** Runtime roles the simulator workspace needs beyond `database(t).grantRuntime()`. */
const simulatorRuntimeRoles = [
  'luma_exceptions',
  'luma_connectors',
  'luma_inventory',
  'luma_orders',
  'luma_customers',
  'luma_commerce_sync',
];

/**
 * Fixed secrets of imported scenarios: every copy decrypts the connection credentials and
 * signs in with the password its snapshot was seeded with. Synthetic test values only.
 */
const snapshotSecrets = {
  keys: {
    test: createHash('sha256')
      .update('luma-e2e-scenario-snapshot')
      .digest('base64'),
  },
  seedPassword: 'scenario-snapshot-seed-password',
};

/** Feature releases an observability runtime grants, as a comparable part of a scenario. */
async function releasedFlags(observability) {
  if (!observability) return [];
  const released = createTenantFeatureRelease(observability);
  const tenantId = '00000000-0000-4000-8000-000000000000';
  const enabled = await Promise.all(
    featureFlags.map((flag) => released(tenantId, flag)),
  );

  return featureFlags.filter((_, index) => enabled[index]);
}

/**
 * Runs commerce sync passes until every stream finished its initial import, without the
 * inventory check. Rejects with the stream states when the import does not complete.
 */
async function importScenario(pilot, owner) {
  let state;
  for (let round = 0; round < 20; round++) {
    await pilot.observe({ check: false });
    state = (
      await owner.query(
        `SELECT count(*)::int AS streams,
          count(*) FILTER (WHERE phase = 'backfill' OR scan IS NOT NULL
            OR suspended_scan IS NOT NULL)::int AS importing
        FROM commerce_sync_streams`,
      )
    ).rows[0];
    if (state.streams && !state.importing) return;
  }
  const { rows } = await owner.query(
    `SELECT connection_id, record_type, phase, scan, paused, blocked, error_code, attempts
     FROM commerce_sync_streams ORDER BY connection_id, record_type`,
  );
  throw new Error(
    `The scenario's initial import did not complete: ${JSON.stringify(rows)}`,
  );
}

/**
 * Prepares an imported scenario under `names`: seeds a workspace against a new simulator run
 * like a fresh journey, imports it completely and stops every service, so both databases can
 * be copied. Resolves to the pilot directory's files and the simulator role's password.
 */
async function prepareScenario(names, environment) {
  const adminUrl = process.env.TEST_DATABASE_URL;
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  const cleanups = [];
  const scope = { onTestFinished: (callback) => cleanups.push(callback) };
  try {
    const password = randomUUID();
    await admin.query(
      `CREATE DATABASE "${names.luma}" TEMPLATE "${names.template}"`,
    );
    await admin.query(
      `CREATE ROLE "${names.runtime}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`,
    );
    await admin.query(
      `GRANT ${[...new Set([...runtimeRoles, ...simulatorRuntimeRoles])].join(',')} TO "${names.runtime}"`,
    );
    const url = new URL(adminUrl);
    url.pathname = `/${names.luma}`;
    const owner = new Pool({ connectionString: url.toString(), max: 1 });
    cleanups.push(() => owner.end());
    url.username = names.runtime;
    url.password = password;
    const simulatorPassword = randomUUID();
    const databaseUrl = await provisionSimulatorDatabase(adminUrl, {
      database: names.simulator,
      role: names.simulator,
      password: simulatorPassword,
    });
    const directory = await mkdtemp(join(tmpdir(), 'luma-scenario-snapshot-'));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const fixture = await createSimulatorEnvironment({
      ...environment,
      t: scope,
      directory,
      databaseUrl,
      env: {
        ...environment.env,
        IDENTITY_DATABASE_URL: url.toString(),
        WORKFLOW_DATABASE_URL: url.toString(),
        CONNECTIONS_KEYS: JSON.stringify(snapshotSecrets.keys),
      },
      saved: { seedPassword: snapshotSecrets.seedPassword },
    });
    try {
      await importScenario(fixture.pilot, owner);
    } finally {
      await fixture.close();
    }
    const files = {};
    for (const file of await readdir(directory))
      files[file] = await readFile(join(directory, file), 'utf8');

    return { files, simulatorPassword };
  } finally {
    // Copies are only possible once nobody is connected to the prepared databases.
    for (const cleanup of cleanups.reverse()) await cleanup();
    await admin.end();
  }
}

/**
 * Provisions and cleans an isolated database-backed simulator workspace for platform tests.
 *
 * With `imported: true` the workspace starts with the simulated shop's initial import already
 * complete, as after `pilot.observe({ check: false })`. The first journey in a run that asks for
 * a scenario prepares it once; each journey then gets its own copies of the Luma and simulator
 * databases, so journeys stay isolated. Use it only when a test does not verify the initial
 * import itself or change the simulated shop before its first read. Imported scenarios are
 * prepared without Temporal, model gateway or supplier extraction; workflows those services
 * would start during the import do not run.
 */
export async function setupSimulator(
  t,
  {
    imported = false,
    temporal,
    origin = 'http://127.0.0.1:3000',
    profile = 'test',
    erp,
    historyDays,
    chaos = 'calm',
    detection,
    demo,
    observability,
    modelGateway,
    supplierExtraction,
    featureFlagOverrides,
  } = {},
) {
  const flags = featureFlagOverrides
    ? {
        FEATURE_FLAG_OVERRIDES: Object.entries({
          'starshipit-fulfillment': true,
          'starshipit-actions': true,
          'shopify-shipment-publishing': true,
          ...featureFlagOverrides,
        })
          .map(([flag, value]) => `${flag}=${value}`)
          .join(','),
      }
    : {};
  const environment = {
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
    observability,
    modelGateway,
    supplierExtraction,
    env: {
      ...flags,
      BETTER_AUTH_SECRET: secret,
      BETTER_AUTH_URL: origin,
      AUTH_RATE_LIMIT: 'off',
      CONNECTIONS_ACTIVE_KEY_ID: 'test',
    },
  };
  const scenario = imported
    ? scenarioName({
        profile,
        erp,
        historyDays,
        chaos,
        demo,
        flags: flags.FEATURE_FLAG_OVERRIDES?.split(',').sort() ?? null,
        released: await releasedFlags(observability),
        region: process.env.LUMA_REGION ?? 'AU',
      })
    : null;
  const snapshot = scenario
    ? await preparedSnapshot(scenario, (names) =>
        prepareScenario(names, {
          ...environment,
          temporal: null,
          modelGateway: undefined,
          supplierExtraction: undefined,
        }),
      )
    : null;
  const db = await database(
    t,
    snapshot ? { template: snapshot.names.luma } : {},
  );
  await db.migrate();
  await db.grantRuntime();
  const role = new URL(db.runtimeUrl).username;
  await db.owner.query(`GRANT ${simulatorRuntimeRoles.join(',')} TO "${role}"`);
  const directory = await mkdtemp(join(tmpdir(), 'luma-operations-e2e-'));
  t.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  if (snapshot)
    for (const [file, content] of Object.entries(snapshot.description.files))
      await writeFile(join(directory, file), content, { mode: 0o600 });
  const fixture = await createSimulatorEnvironment({
    ...environment,
    t,
    directory,
    ...(snapshot
      ? {
          databaseUrl: await copySimulatorDatabase(t, {
            template: snapshot.names.simulator,
            role: snapshot.names.simulator,
            password: snapshot.description.simulatorPassword,
          }),
          manifest: JSON.parse(snapshot.description.files['pilot.json']),
        }
      : {}),
    env: {
      ...environment.env,
      IDENTITY_DATABASE_URL: db.runtimeUrl,
      WORKFLOW_DATABASE_URL: db.runtimeUrl,
      CONNECTIONS_KEYS: JSON.stringify(
        snapshot
          ? snapshotSecrets.keys
          : { test: randomBytes(32).toString('base64') },
      ),
    },
    saved: {
      seedPassword: snapshot ? snapshotSecrets.seedPassword : randomUUID(),
    },
  });
  // Without a run template to name snapshots after, the journey imports by itself.
  if (imported && !snapshot) await importScenario(fixture.pilot, db.owner);
  t.onTestFinished(async () => {
    try {
      if (!(t.failed ?? t.task?.result?.state === 'fail')) return;
      const path = join(
        tmpdir(),
        `luma-operations-failure-${fixture.manifest.runId}-${randomUUID()}.json`,
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

  return {
    ...fixture,
    db,
    async restartPilot(options) {
      const current = await fixture.restartPilot(options);
      // Failure evidence and cleanup must use the reconstructed services, too.
      fixture.pilot = current;

      return current;
    },
  };
}

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  buildRuntimeApp,
  createDetectionServices,
} from '@luma/application-runtime';
import { defaultConfiguration } from '@luma/exceptions';
import { parseInput } from '@luma/exceptions/composition';
import { createIdentity } from '@luma/identity/composition';
import { Pool } from 'pg';

import { stateDirectory } from './environment.mjs';

/**
 * Seeds the local demo workspace and writes its sign-in details to the selected output
 * directory.
 */
export async function seed(saved, env, outputDirectory = stateDirectory) {
  const settings = {
    region: env.LUMA_REGION ?? 'AU',
    enabledRegions: [env.LUMA_REGION ?? 'AU'],
    databaseUrl: env.IDENTITY_DATABASE_URL,
    secret: env.BETTER_AUTH_SECRET,
    cookiePrefix: env.BETTER_AUTH_COOKIE_PREFIX,
    baseURL: env.BETTER_AUTH_URL,
    trustedOrigins: [env.BETTER_AUTH_URL],
  };
  const app = await buildRuntimeApp(settings);
  const identity = createIdentity(settings);
  const corpus = JSON.parse(
    await readFile(
      new URL(
        '../../packages/exceptions/fixtures/exceptions-v0.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  const detection = createDetectionServices(
    env.WORKFLOW_DATABASE_URL,
    () => new Date(corpus.now),
  );
  const email = 'demo@example.test';
  let cookie = '';
  const request = (url, payload) =>
    app.inject({
      method: payload ? 'POST' : 'GET',
      url,
      headers: { origin: settings.baseURL, cookie },
      ...(payload ? { payload } : {}),
    });
  const expect = (response, status) => {
    if (response.statusCode !== status)
      throw new Error(
        `Demo setup failed (${response.statusCode}): ${response.body}`,
      );

    return response.json();
  };
  const users = new Pool({ connectionString: settings.databaseUrl, max: 1 });
  try {
    const signIn = () =>
      request('/auth/sign-in/email', { email, password: saved.seedPassword });
    let auth = await signIn();
    if (auth.statusCode === 401)
      expect(
        await request('/auth/sign-up/email', {
          dataRegion: env.LUMA_REGION ?? 'AU',
          email,
          password: saved.seedPassword,
          name: 'Demo operator',
        }),
        200,
      );
    if (auth.statusCode !== 200) {
      // The synthetic demo address has no mailbox, so the seed confirms it directly.
      await users.query('UPDATE users SET email_verified=true WHERE email=$1', [
        email,
      ]);
      auth = await signIn();
    }
    expect(auth, 200);
    const cookies = auth.headers['set-cookie'];
    cookie = (Array.isArray(cookies) ? cookies : [cookies])
      .filter(Boolean)
      .map((value) => value.split(';')[0])
      .join('; ');
    const { items } = expect(await request('/v1/organizations'), 200);
    const organization =
      items.find((item) => item.slug === 'demo-workspace') ??
      expect(
        await request('/v1/organizations', {
          name: 'Demo workspace',
          slug: 'demo-workspace',
          dataRegion: settings.region,
        }),
        201,
      );
    const context = await identity.service.resolveTenant(
      { cookie },
      organization.id,
      'local-seed',
    );
    const connectionId = '11111111-1111-4111-8111-111111111111';
    const incidents = await detection.exceptions.list(context);
    const evidence = await Promise.all(
      incidents.map((incident) =>
        detection.exceptions.evidence(context, incident.id),
      ),
    );
    const existingKeys = new Set(evidence.flat().map((item) => item.key));
    for (const kind of ['sync_failure', 'workflow_failure']) {
      const key = `local-demo-${kind}-v1`;
      // Ingesting persisted evidence again records another evaluation.
      if (existingKeys.has(key)) continue;
      await detection.exceptions.ingest(context, {
        key,
        input: parseInput(kind, {
          ...corpus.bases[kind],
          tenantId: organization.id,
          evidenceTenantId: organization.id,
          subjectId:
            kind === 'sync_failure'
              ? connectionId
              : '22222222-2222-4222-8222-222222222222',
          evidenceRefs: [key],
          ...(kind === 'sync_failure'
            ? { connectionId }
            : { runId: '22222222-2222-4222-8222-222222222222' }),
        }),
        configuration: structuredClone(defaultConfiguration),
        evidence: [
          {
            key,
            tenantId: organization.id,
            connectionId: kind === 'sync_failure' ? connectionId : null,
            observedAt: corpus.now,
            sourceUpdatedAt: null,
            adapterVersion: 'local-demo-v1',
            schemaVersion: 1,
            source: null,
            facts: { synthetic: true, scenario: kind },
          },
        ],
      });
    }
    expect(await request('/auth/sign-out', {}), 200);
    await writeFile(
      join(outputDirectory, 'demo.json'),
      `${JSON.stringify({ email, password: saved.seedPassword, organizationId: organization.id }, null, 2)}\n`,
      { mode: 0o600 },
    );
    console.log(
      'Demo workspace and two synthetic exception scenarios are ready.',
    );
  } finally {
    await Promise.all([
      app.close(),
      identity.close(),
      detection.close(),
      users.end(),
    ]);
  }
}

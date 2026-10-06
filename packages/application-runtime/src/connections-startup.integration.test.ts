import type { ChildProcess } from 'node:child_process';
import { fork } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';

import {
  installedConnectionSchema,
  organizationSchema,
} from '@luma/api-contract';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)('connections through the API CLI', () => {
  const name = `startup_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: databaseUrl });
  const keys = JSON.stringify({ test: randomBytes(32).toString('base64') });
  let owner: Pool;
  let runtimeUrl: string;
  let child: ChildProcess | undefined;
  let origin: string;
  let cookie: string;
  let organizationId: string;

  async function stop() {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    await exited;
    child = undefined;
  }

  async function start(configured = true) {
    child = fork(
      new URL(
        '../../../apps/api/src/composition/bootstrap.ts',
        import.meta.url,
      ),
      [],
      {
        execArgv: [
          '--conditions=luma-source',
          '--import',
          'tsx',
          '--import',
          `data:text/javascript,${encodeURIComponent(`
        globalThis.fetch = async (url, init) => {
          if (new URL(url).hostname !== 'example.myshopify.com') throw new Error('Unexpected provider');
          if (new Headers(init.headers).get('x-shopify-access-token') !== 'startup-private-token') return new Response(null, { status: 401 });
          return Response.json({ data: { shop: { myshopifyDomain: 'example.myshopify.com' }, currentAppInstallation: { accessScopes: [{ handle: 'read_products' }, { handle: 'read_inventory' }] } } });
        };
      `)}`,
        ],
        env: {
          ...process.env,
          NODE_ENV: 'test',
          HOST: '127.0.0.1',
          PORT: '0',
          LOG_LEVEL: 'silent',
          IDENTITY_DATABASE_URL: runtimeUrl,
          BETTER_AUTH_SECRET: 'startup-test-secret-at-least-32-characters',
          BETTER_AUTH_URL: 'http://localhost:3001',
          AUTH_TRUSTED_ORIGINS: 'http://localhost:3001',
          CONNECTIONS_ACTIVE_KEY_ID: configured ? 'test' : '',
          CONNECTIONS_KEYS: configured ? keys : '',
          JTL_ALLOWED_ENDPOINTS: '[]',
          MODEL_GATEWAY_ROUTES: '{}',
          SENTRY_DSN: '',
          LANGFUSE_PUBLIC_KEY: '',
          LANGFUSE_SECRET_KEY: '',
          POSTHOG_API_KEY: '',
        },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      },
    );
    const serverProcess = child;
    origin = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        serverProcess.kill();
        reject(new Error('API did not start'));
      }, 15000);
      serverProcess.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      serverProcess.once('exit', () => {
        clearTimeout(timer);
        reject(new Error('API exited before startup'));
      });
      serverProcess.once('message', (message: unknown) => {
        clearTimeout(timer);
        resolve((message as { address: string }).address);
      });
    });
  }

  async function call(path: string, body?: unknown) {
    return fetch(`${origin}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        origin: 'http://localhost:3001',
        'content-type': 'application/json',
        ...(cookie ? { cookie } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  beforeAll(async () => {
    await admin.query(`CREATE DATABASE "${name}"`);
    const url = new URL(databaseUrl!);
    url.pathname = `/${name}`;
    owner = new Pool({ connectionString: url.toString() });
    const lock = await admin.connect();
    try {
      await lock.query(
        "SELECT pg_advisory_lock(hashtext('luma_test_role_setup'))",
      );
      for (const migration of [
        '0001_identity.sql',
        '0004_connector_installations.sql',
        '0024_workspace_apps.sql',
        '0052_authentication_factors.sql',
      ]) {
        await owner.query(
          await readFile(
            new URL(`../migrations/${migration}`, import.meta.url),
            'utf8',
          ),
        );
      }
    } finally {
      await lock.query(
        "SELECT pg_advisory_unlock(hashtext('luma_test_role_setup'))",
      );
      lock.release();
    }
    const password = randomUUID();
    await admin.query(
      `CREATE ROLE "${name}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`,
    );
    await admin.query(`GRANT luma_identity,luma_connectors TO "${name}"`);
    url.username = name;
    url.password = password;
    runtimeUrl = url.toString();
    await start();
    const signup = await call('/auth/sign-up/email', {
      name: 'Operator',
      email: 'operator@example.test',
      password: 'test-password-long-enough',
    });
    expect(signup.status).toBe(200);
    cookie = signup.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ');
    const organization = await call('/v1/organizations', {
      name: 'Store',
      slug: 'store',
    });
    expect(organization.status).toBe(201);
    organizationId = organizationSchema.parse(await organization.json()).id;
  }, 30000);
  afterAll(async () => {
    await stop();
    await owner?.end();
    await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
    await admin.query(`DROP ROLE IF EXISTS "${name}"`);
    await admin.end();
  });
  it('lists and stores connections across normal CLI restarts with restricted credentials', async () => {
    expect((await call('/ready')).status).toBe(200);
    const path = `/v1/organizations/${organizationId}/connections`;
    const list = await call(path);
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({ items: [] });
    expect(
      (
        await call(`/v1/organizations/${organizationId}/apps/shopify/install`, {
          version: null,
        })
      ).status,
    ).toBe(200);
    const created = await call(path, {
      label: 'Store',
      target: { kind: 'shopify', shop: 'example.myshopify.com' },
      permissions: ['products.read'],
      credentials: { token: 'startup-private-token' },
    });
    expect(created.status).toBe(201);
    const connection = installedConnectionSchema.parse(await created.json());
    expect(connection.status).toBe('pending');
    expect(JSON.stringify(connection)).not.toContain('startup-private-token');
    const stored = await owner.query('SELECT * FROM connector_installations');
    expect(JSON.stringify(stored.rows)).not.toContain('startup-private-token');
    await stop();
    await start();
    expect(await (await call(path)).json()).toEqual({ items: [connection] });
    const checked = await call(`${path}/${connection.id}/check`, {
      version: 1,
    });
    expect(checked.status).toBe(200);
    const verified = installedConnectionSchema.parse(await checked.json());
    expect(verified.status).toBe('active');
    const disconnected = await call(`${path}/${connection.id}/disconnect`, {
      version: verified.version,
    });
    expect(disconnected.status).toBe(200);
    expect(
      installedConnectionSchema.parse(await disconnected.json()).status,
    ).toBe('disconnected');
    await stop();
    await start(false);
    const unavailable = await call(path);
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      message: 'Connection service is unavailable',
    });
  }, 30000);
  it('fails readiness when the configured runtime loses its connector role', async () => {
    await stop();
    await admin.query(`REVOKE luma_connectors FROM "${name}"`);
    await start();
    expect((await call('/ready')).status).toBe(503);
  });
});

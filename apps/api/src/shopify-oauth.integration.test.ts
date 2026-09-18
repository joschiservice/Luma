import { readFileSync } from 'node:fs';
import { buildSchema, parse, validate } from 'graphql';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createShopifyOAuth,
  createSecretCipher,
  createInstalledConnections,
} from '#modules/connectors/composition';
import { createTenantDatabase } from '#modules/platform/composition';
import { makeTenantContext } from '#modules/identity/composition';
import { ConnectorError } from '#modules/connectors/index';
const schema = buildSchema(
  readFileSync(
    new URL(
      './modules/connectors/infrastructure/shopify/fixtures/admin-2026-07.graphql',
      import.meta.url,
    ),
    'utf8',
  ),
);
const databaseUrl = process.env.TEST_DATABASE_URL;
const scopes =
  'read_orders,read_products,read_inventory,read_merchant_managed_fulfillment_orders,read_third_party_fulfillment_orders';
const reads = [
  'orders.read',
  'products.read',
  'inventory.read',
  'fulfillment.read',
] as const;
const config = {
  clientId: 'client',
  clientSecret: 'test-client-secret',
  environment: 'development',
  callbackUrl: 'https://luma.test/api/v1/shopify/callback',
  webOrigin: 'https://luma.test',
};
const context = (
  id: string = randomUUID(),
  userId = 'admin',
  sessionId = 'session',
  role: 'admin' | 'member' = 'admin',
) =>
  makeTenantContext(
    { userId, sessionId },
    { id, name: 'Store', slug: 'store', dataRegion: 'EU', status: 'active' },
    { id: 'membership', organizationId: id, userId, role },
    randomUUID(),
  );
describe.skipIf(!databaseUrl)('Shopify OAuth on PostgreSQL', () => {
  const name = `oauth_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: databaseUrl });
  let owner: Pool;
  let runtime: Pool;
  const keys = new Map([['test', randomBytes(32)]]);
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
      await owner.query(
        await readFile(
          new URL(
            '../migrations/0004_connector_installations.sql',
            import.meta.url,
          ),
          'utf8',
        ),
      );
    } finally {
      await lock.query(
        "SELECT pg_advisory_unlock(hashtext('luma_test_role_setup'))",
      );
      lock.release();
    }
    await owner.query(
      await readFile(
        new URL('../migrations/0006_shopify_oauth.sql', import.meta.url),
        'utf8',
      ),
    );
    const password = randomUUID();
    await admin.query(
      `CREATE ROLE "${name}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`,
    );
    await admin.query(`GRANT luma_connectors TO "${name}"`);
    url.username = name;
    url.password = password;
    runtime = new Pool({ connectionString: url.toString(), max: 2 });
  });
  afterAll(async () => {
    await runtime?.end();
    await owner?.end();
    await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
    await admin.query(`DROP ROLE IF EXISTS "${name}"`);
    await admin.end();
  });

  function fixture() {
    let clock = new Date('2026-09-18T01:00:00Z');
    let counter = 0;
    let granted = scopes;
    let revoked = false;
    let transient = false;
    const transport = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).endsWith('/admin/oauth/access_token')) {
        if (transient) return new Response(null, { status: 503 });
        if (revoked) return new Response(null, { status: 400 });
        counter++;
        return Response.json({
          access_token: `private-access-${counter}`,
          refresh_token: `private-refresh-${counter}`,
          expires_in: 3600,
          refresh_token_expires_in: 7776000,
          scope: granted,
        });
      }
      const query = JSON.parse(String(init?.body)).query as string;
      expect(
        validate(schema, parse(query)).map((error) => error.message),
      ).toEqual([]);
      if (query.includes('LumaUninstallSubscriptions'))
        return Response.json({ data: { webhookSubscriptions: { nodes: [] } } });
      return Response.json({
        data: {
          webhookSubscriptionCreate: {
            webhookSubscription: { id: 'gid://shopify/WebhookSubscription/1' },
            userErrors: [],
          },
        },
      });
    });
    const verify = vi.fn(async () => {
      if (revoked)
        throw new ConnectorError({
          code: 'authentication',
          effect: 'none',
          retry: 'never',
        });
      return [...reads];
    });
    const db = createTenantDatabase(runtime);
    const cipher = createSecretCipher('test', keys);
    const deps = {
      cipher,
      verify,
      fetch: transport,
      refreshContext: async (c: ReturnType<typeof context>) => c,
      now: () => clock,
    };
    const oauth = createShopifyOAuth(db, config, deps);
    const ctx = context();
    const shop = `shop-${randomUUID()}.myshopify.com`;
    async function query(
      overrides: Record<string, string> = {},
      authorizer = oauth,
    ) {
      const start = await authorizer.start(ctx, { shop, label: 'Shop' });
      const state = new URL(start.authorizationUrl).searchParams.get('state')!;
      const params = new URLSearchParams({
        shop,
        state,
        code: 'private-code',
        timestamp: String(Math.floor(clock.getTime() / 1000)),
        ...overrides,
      });
      const message = [...params.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => `${k}=${v}`)
        .join('&');
      params.set(
        'hmac',
        createHmac('sha256', config.clientSecret).update(message).digest('hex'),
      );
      return params.toString();
    }
    async function connection() {
      return (
        await createInstalledConnections(db, {
          keys,
          activeKeyId: 'test',
          refreshContext: deps.refreshContext,
          verify,
        }).list(ctx)
      )[0]!;
    }
    return {
      ctx,
      shop,
      oauth,
      query,
      connection,
      transport,
      verify,
      db,
      cipher,
      deps,
      advance: (milliseconds = 3600000) => {
        clock = new Date(clock.getTime() + milliseconds);
      },
      missingScopes: () => {
        granted = 'read_orders';
      },
      revoke: () => {
        revoked = true;
      },
      restore: () => {
        revoked = false;
      },
      transient: () => {
        transient = true;
      },
    };
  }
  it('authorizes, stores encrypted credentials and blocks replay and foreign tenants', async () => {
    const f = fixture();
    const q = await f.query();
    expect(f.oauth.callbackTenant(q)).toBe(f.ctx.tenantId);
    await expect(f.oauth.callback(context(), q)).rejects.toThrow();
    await expect(
      f.oauth.callback(context(f.ctx.tenantId, 'other'), q),
    ).rejects.toThrow();
    await expect(
      f.oauth.callback(context(f.ctx.tenantId, 'admin', 'other-session'), q),
    ).rejects.toThrow();
    expect(await f.oauth.callback(f.ctx, q)).toBe('connected');
    const c = await f.connection();
    expect(c.status).toBe('active');
    expect((await f.oauth.credential(f.ctx, c.id)).token).toBe(
      'private-access-1',
    );
    await expect(f.oauth.callback(f.ctx, q)).rejects.toThrow();
    const rows = await owner.query(
      'SELECT secret FROM connector_installations WHERE tenant_id=$1',
      [f.ctx.tenantId],
    );
    expect(JSON.stringify(rows.rows)).not.toContain('private-access');
    expect(JSON.stringify(rows.rows)).not.toContain('private-refresh');
    expect(
      (
        await f.db.transaction(context().tenantId, (tx) =>
          tx.query('SELECT * FROM shopify_installation_bindings'),
        )
      ).rows,
    ).toEqual([]);
    const other = context();
    const start = await f.oauth.start(other, {
      shop: f.shop,
      label: 'Foreign',
    });
    const params = new URLSearchParams(q);
    params.set(
      'state',
      new URL(start.authorizationUrl).searchParams.get('state')!,
    );
    params.delete('hmac');
    const message = [...params.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${k}=${v}`)
      .join('&');
    params.set(
      'hmac',
      createHmac('sha256', config.clientSecret).update(message).digest('hex'),
    );
    await expect(f.oauth.callback(other, params.toString())).rejects.toThrow(
      'already connected',
    );
  });
  it('rejects signatures, duplicate parameters, shop mismatch, expired state and wrong app', async () => {
    const f = fixture();
    const q = await f.query();
    expect(() =>
      f.oauth.callbackTenant(q.replace('private-code', 'tampered')),
    ).toThrow();
    expect(() =>
      f.oauth.callbackTenant(q + '&shop=evil.myshopify.com'),
    ).toThrow();
    const wrong = createShopifyOAuth(
      f.db,
      { ...config, environment: 'production' },
      f.deps,
    );
    await expect(wrong.callback(f.ctx, q)).rejects.toThrow();
    await expect(
      f.oauth.callback(f.ctx, await f.query({ shop: 'other.myshopify.com' })),
    ).rejects.toThrow();
    f.advance();
    await expect(f.oauth.callback(f.ctx, q)).rejects.toThrow();
    await expect(
      f.oauth.start(f.ctx, { shop: 'evil.com', label: 'Shop' }),
    ).rejects.toThrow();
    await expect(
      f.oauth.start(context(f.ctx.tenantId, 'admin', 'session', 'member'), {
        shop: f.shop,
        label: 'Shop',
      }),
    ).rejects.toThrow();
  });
  it('consumes cancellation and preserves a clear permission failure', async () => {
    const f = fixture();
    const q = await f.query({ error: 'access_denied' });
    expect(await f.oauth.callback(f.ctx, q)).toBe('denied');
    await expect(f.oauth.callback(f.ctx, q)).rejects.toThrow();
    f.missingScopes();
    expect(await f.oauth.callback(f.ctx, await f.query())).toBe('permissions');
    expect((await f.connection()).status).toBe('degraded');
    await expect(
      f.oauth.credential(f.ctx, (await f.connection()).id),
    ).rejects.toThrow();
  });
  it('serializes refresh across instances and atomically persists rotated pairs', async () => {
    const f = fixture();
    await f.oauth.callback(f.ctx, await f.query());
    const c = await f.connection();
    f.advance();
    const second = createShopifyOAuth(f.db, config, f.deps);
    const results = await Promise.all([
      f.oauth.credential(f.ctx, c.id),
      second.credential(f.ctx, c.id),
    ]);
    expect(results.map((r) => r.token)).toEqual([
      'private-access-2',
      'private-access-2',
    ]);
    expect(results[0]!.shopify!.refreshToken).toBe('private-refresh-2');
    expect(
      f.transport.mock.calls.filter(([url]) =>
        String(url).includes('access_token'),
      ),
    ).toHaveLength(2);
    f.advance();
    await second.credential(f.ctx, c.id);
    const calls = f.transport.mock.calls.filter(([url]) =>
      String(url).includes('access_token'),
    );
    expect(JSON.parse(String(calls.at(-1)![1]!.body)).refresh_token).toBe(
      'private-refresh-2',
    );
    expect((await f.connection()).credentialVersion).toBe(3);
  });
  it('keeps credentials on temporary failure and revokes rejected refresh tokens', async () => {
    const f = fixture();
    await f.oauth.callback(f.ctx, await f.query());
    const c = await f.connection();
    f.advance();
    f.revoke();
    await expect(f.oauth.credential(f.ctx, c.id)).rejects.toThrow();
    expect((await f.connection()).status).toBe('revoked');
    const other = fixture();
    await other.oauth.callback(other.ctx, await other.query());
    other.advance();
    other.transient();
    await expect(
      other.oauth.credential(other.ctx, (await other.connection()).id),
    ).rejects.toThrow();
    expect((await other.connection()).status).toBe('active');
  });
  it('verifies uninstall, ignores delayed delivery after reconnect and reuses the connection ID', async () => {
    const f = fixture();
    await f.oauth.callback(f.ctx, await f.query());
    const c = await f.connection();
    const body = Buffer.from(JSON.stringify({ myshopify_domain: f.shop }));
    const mac = createHmac('sha256', config.clientSecret)
      .update(body)
      .digest('base64');
    await expect(
      f.oauth.uninstall(
        f.ctx.tenantId,
        c.id,
        body,
        'bad',
        f.shop,
        'app/uninstalled',
      ),
    ).rejects.toThrow();
    f.revoke();
    await f.oauth.uninstall(
      f.ctx.tenantId,
      c.id,
      body,
      mac,
      f.shop,
      'app/uninstalled',
    );
    expect((await f.connection()).status).toBe('revoked');
    await expect(f.oauth.credential(f.ctx, c.id)).rejects.toThrow();
    f.restore();
    await f.oauth.callback(f.ctx, await f.query());
    expect((await f.connection()).id).toBe(c.id);
    f.advance();
    await f.oauth.uninstall(
      f.ctx.tenantId,
      c.id,
      body,
      mac,
      f.shop,
      'app/uninstalled',
    );
    expect((await f.connection()).status).toBe('active');
  });
  it('requires reconnect when the refresh token expires without sending it to Shopify', async () => {
    const f = fixture();
    await f.oauth.callback(f.ctx, await f.query());
    const c = await f.connection();
    const calls = f.transport.mock.calls.length;
    f.advance(91 * 24 * 3600000);
    await expect(f.oauth.credential(f.ctx, c.id)).rejects.toThrow();
    expect(f.transport.mock.calls).toHaveLength(calls);
    expect((await f.connection()).status).toBe('revoked');
  });
  it('reconnects the same connection when moving from a pilot to the production app', async () => {
    const f = fixture();
    await f.oauth.callback(f.ctx, await f.query());
    const previous = await f.connection();
    const production = createShopifyOAuth(
      f.db,
      { ...config, clientId: 'production-client', environment: 'production' },
      f.deps,
    );
    expect(
      await production.callback(f.ctx, await f.query({}, production)),
    ).toBe('connected');
    expect((await f.connection()).id).toBe(previous.id);
    await expect(f.oauth.credential(f.ctx, previous.id)).rejects.toThrow();
    expect((await production.credential(f.ctx, previous.id)).shopify?.app).toBe(
      'production:production-client',
    );
  });
});

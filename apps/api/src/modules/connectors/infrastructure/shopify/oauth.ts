import { createHash, randomBytes, randomUUID } from 'node:crypto';

import {
  callbackParams,
  createClient,
  createOAuthClient,
  parse,
  shopHostname,
  shopifyScopes,
  validMac,
} from '@luma/connector-shopify';
import { z } from 'zod';

import type {
  InstallationDependencies,
  StoredInstallation,
} from '#modules/connectors/application/installations';
import { secretBinding } from '#modules/connectors/application/installations';
import type { ShopifyAppConfig as ShopifyConfig } from '#modules/connectors/application/shopify';
import { ConnectorError } from '#modules/connectors/domain/capabilities';
import type {
  InstallationCredentials,
  InstalledConnection,
} from '#modules/connectors/domain/installation';
import { createInstallationRepository } from '#modules/connectors/infrastructure/installations/repository';
import type { TenantContext } from '#modules/identity/index';
import { IdentityError, requireRole } from '#modules/identity/index';
import type { SqlTransaction, TenantDatabase } from '#modules/platform/index';

const invalid = () =>
  new IdentityError(
    422,
    'CONFLICT',
    'Shopify authorization expired or is invalid. Connect again.',
  );

const unavailable = () =>
  new ConnectorError({
    code: 'authentication',
    effect: 'none',
    retry: 'never',
  });

const digest = (state: string) =>
  createHash('sha256').update(state).digest('hex');

export const oauthStartInput = z
  .object({ shop: shopHostname, label: z.string().trim().min(1).max(120) })
  .strict();

const shopifyReads = [
  'orders.read',
  'products.read',
  'inventory.read',
  'fulfillment.read',
] as const;

/** Identifies an OAuth application within its configured environment. */
const appBinding = (config: ShopifyConfig) =>
  `${config.environment}:${config.clientId}`;

/**
 * Creates tenant-bound Shopify authorization, credential refresh, and uninstall handling
 * backed by persistent OAuth state.
 */
export function createShopifyOAuth(
  db: TenantDatabase,
  config: ShopifyConfig,
  deps: Pick<
    InstallationDependencies,
    'cipher' | 'refreshContext' | 'verify'
  > & { fetch?: typeof globalThis.fetch; now?: () => Date },
) {
  const now = deps.now ?? (() => new Date());
  const app = appBinding(config);
  const oauthClient = createOAuthClient(config, deps.fetch, now);
  const client = {
    async token(
      ...args: Parameters<typeof oauthClient.token>
    ): Promise<InstallationCredentials> {
      const { token, ...shopify } = await oauthClient.token(...args);

      return { token, shopify: { ...shopify, app: appBinding(config) } };
    },
  };
  const repository = createInstallationRepository(db);

  function scoped(tx: SqlTransaction, tenantId: string) {
    return createInstallationRepository({
      transaction: async (tenant, operation) => {
        if (tenant !== tenantId) throw invalid();

        return operation(tx);
      },
    });
  }

  async function locked<T>(
    tenantId: string,
    shop: string,
    operation: (tx: SqlTransaction) => Promise<T>,
  ) {
    return db.transaction(tenantId, async (tx) => {
      // Serialize token acquisition and refresh across API and worker processes.
      await tx.query(
        "SELECT set_config('statement_timeout','30000',true), set_config('idle_in_transaction_session_timeout','90000',true)",
      );
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        JSON.stringify([app, shop]),
      ]);
      await tx.query(
        "SELECT id FROM connector_installations WHERE tenant_id=$1 AND document->'target'->>'kind'='shopify' AND document->'target'->>'shop'=$2 FOR UPDATE",
        [tenantId, shop],
      );

      return operation(tx);
    });
  }

  async function persist(
    tx: SqlTransaction,
    record: StoredInstallation | null,
    connection: InstalledConnection,
    credentials: InstallationCredentials | null,
    actor: string,
    event: string,
  ) {
    const secret = credentials
      ? deps.cipher.seal(credentials, secretBinding(connection))
      : null;
    if (
      !(await scoped(tx, connection.tenantId).save(
        { connection, secret },
        record?.connection.version ?? null,
        actor,
        event,
      ))
    )
      throw new IdentityError(
        409,
        'CONFLICT',
        'Connection changed. Connect again.',
      );
  }

  function next(
    record: StoredInstallation,
    status: InstalledConnection['status'],
  ): InstalledConnection {
    return {
      ...record.connection,
      status,
      version: record.connection.version + 1,
      updatedAt: now().toISOString(),
    };
  }

  async function registerUninstall(
    connection: InstalledConnection,
    credentials: InstallationCredentials,
  ) {
    if (connection.target.kind !== 'shopify') throw invalid();
    const request = createClient({
      shop: connection.target.shop,
      accessToken: async () => credentials.token,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
    });
    const url = new URL(config.callbackUrl);
    url.pathname = `/api/v1/shopify/uninstall/${connection.tenantId}/${connection.id}`;
    // Shopify rejects identical subscriptions; list first so reconnect remains idempotent.
    const subscriptions = parse(
      z.object({
        webhookSubscriptions: z.object({
          nodes: z.array(z.object({ uri: z.string() })),
        }),
      }),
      await request(
        'query LumaUninstallSubscriptions { webhookSubscriptions(first: 100, topics: [APP_UNINSTALLED]) { nodes { uri } } }',
        {},
      ),
    );
    if (
      subscriptions.webhookSubscriptions.nodes.some((s) => s.uri === url.href)
    )
      return;
    const result = parse(
      z.object({
        webhookSubscriptionCreate: z.object({
          webhookSubscription: z.object({ id: z.string() }).nullable(),
          userErrors: z.array(z.object({ message: z.string() })),
        }),
      }),
      await request(
        'mutation LumaUninstall($uri: String!) { webhookSubscriptionCreate(topic: APP_UNINSTALLED, webhookSubscription: { uri: $uri, format: JSON }) { webhookSubscription { id } userErrors { message } } }',
        { uri: url.href },
      ),
    );
    if (
      !result.webhookSubscriptionCreate.webhookSubscription ||
      result.webhookSubscriptionCreate.userErrors.length
    )
      throw unavailable();
  }

  return {
    config: { webOrigin: config.webOrigin },
    async start(context: TenantContext, input: unknown) {
      const fresh = await deps.refreshContext(context);
      requireRole(fresh, ['owner', 'admin']);
      const parsed = oauthStartInput.safeParse(input);
      if (!parsed.success) throw invalid();
      const { shop, label } = parsed.data;
      const state = `${fresh.tenantId}.${randomBytes(32).toString('hex')}`;
      await db.transaction(fresh.tenantId, async (tx) => {
        await tx.query(
          'DELETE FROM shopify_oauth_states WHERE tenant_id=$1 AND (expires_at < now() OR (actor_id=$2 AND app=$3 AND shop=$4))',
          [fresh.tenantId, fresh.actor.id, app, shop],
        );
        await tx.query(
          'INSERT INTO shopify_oauth_states(tenant_id,digest,actor_id,session_id,app,shop,label,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
          [
            fresh.tenantId,
            digest(state),
            fresh.actor.id,
            fresh.actor.sessionId,
            app,
            shop,
            label,
            new Date(now().getTime() + 600000),
          ],
        );
      });
      const url = new URL(`https://${shop}/admin/oauth/authorize`);
      url.search = new URLSearchParams({
        client_id: config.clientId,
        scope: shopifyScopes.join(','),
        redirect_uri: config.callbackUrl,
        state,
      }).toString();

      return { authorizationUrl: url.href };
    },
    callbackTenant(query: string) {
      let params: URLSearchParams;
      try {
        params = callbackParams(query, config.clientSecret);
      } catch {
        throw invalid();
      }
      const state = params.get('state') ?? '';
      if (!/^[0-9a-f-]{36}\.[0-9a-f]{64}$/.test(state)) throw invalid();

      return z.string().uuid().parse(state.split('.')[0]);
    },
    async callback(context: TenantContext, query: string) {
      const fresh = await deps.refreshContext(context);
      requireRole(fresh, ['owner', 'admin']);
      let params: URLSearchParams;
      try {
        params = callbackParams(query, config.clientSecret);
      } catch {
        throw invalid();
      }
      const state = params.get('state') ?? '';
      const shop = params.get('shop') ?? '';
      if (!shopHostname.safeParse(shop).success) throw invalid();
      const attempt = await db.transaction(fresh.tenantId, async (tx) => {
        const result = await tx.query<{ label: string }>(
          'DELETE FROM shopify_oauth_states WHERE tenant_id=$1 AND digest=$2 AND actor_id=$3 AND session_id=$4 AND app=$5 AND shop=$6 AND expires_at > $7 RETURNING label',
          [
            fresh.tenantId,
            digest(state),
            fresh.actor.id,
            fresh.actor.sessionId,
            app,
            shop,
            now(),
          ],
        );

        return result.rows[0];
      });
      if (!attempt) throw invalid();
      if (params.has('error')) return 'denied' as const;
      const code = params.get('code');
      if (!code || code.length > 4096) throw invalid();

      return locked(fresh.tenantId, shop, async (tx) => {
        const repo = scoped(tx, fresh.tenantId);
        const existing = (await repo.list(fresh.tenantId)).filter(
          (c) => c.target.kind === 'shopify' && c.target.shop === shop,
        );
        if (existing.length > 1)
          throw new IdentityError(
            409,
            'CONFLICT',
            'Disconnect duplicate Shopify connections before reconnecting.',
          );
        const candidate = existing[0];
        const id = candidate?.id ?? randomUUID();
        await tx.query(
          'INSERT INTO shopify_installation_bindings(tenant_id,app,shop,connection_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
          [fresh.tenantId, app, shop, id],
        );
        const binding = await tx.query<{ connection_id: string }>(
          'SELECT connection_id FROM shopify_installation_bindings WHERE tenant_id=$1 AND app=$2 AND shop=$3',
          [fresh.tenantId, app, shop],
        );
        if (binding.rows[0]?.connection_id !== id)
          throw new IdentityError(
            409,
            'CONFLICT',
            'Shopify installation is already connected.',
          );
        const record = await repo.get(fresh.tenantId, id);
        const credentials = await client.token(shop, { code });
        const timestamp = now().toISOString();
        const connection: InstalledConnection = {
          id,
          tenantId: fresh.tenantId,
          target: { kind: 'shopify', shop },
          label: attempt.label,
          permissions: [...shopifyReads],
          granted: [],
          status: 'degraded',
          version: (record?.connection.version ?? 0) + 1,
          credentialVersion: (record?.connection.credentialVersion ?? 0) + 1,
          createdAt: record?.connection.createdAt ?? timestamp,
          updatedAt: timestamp,
        };
        // Persist degraded credentials too, so a scope failure has a recoverable connection.
        if (
          shopifyScopes.every((scope) =>
            credentials.shopify!.scopes.includes(scope),
          )
        ) {
          try {
            connection.granted = await deps.verify(connection, credentials);
            await registerUninstall(connection, credentials);
            if (shopifyReads.every((cap) => connection.granted.includes(cap)))
              connection.status = 'active';
          } catch {
            connection.granted = [];
          }
        }
        requireRole(await deps.refreshContext(context), ['owner', 'admin']);
        await persist(
          tx,
          record,
          connection,
          credentials,
          fresh.actor.id,
          'shopify_authorized',
        );

        return connection.status === 'active'
          ? ('connected' as const)
          : ('permissions' as const);
      });
    },
    async credential(context: TenantContext, id: string) {
      const initial = await repository.get(context.tenantId, id);
      if (!initial || initial.connection.target.kind !== 'shopify')
        throw unavailable();
      const outcome = await locked(
        context.tenantId,
        initial.connection.target.shop,
        async (tx) => {
          const record = await scoped(tx, context.tenantId).get(
            context.tenantId,
            id,
          );
          if (!record?.secret || record.connection.status !== 'active')
            return null;
          let credentials = deps.cipher.open(
            record.secret,
            secretBinding(record.connection),
          );
          if (!credentials.shopify) return credentials;
          const oauth = credentials.shopify;
          if (oauth.app !== app) return null;
          if (Date.parse(oauth.expiresAt) > now().getTime() + 60000)
            return credentials;
          try {
            if (Date.parse(oauth.refreshExpiresAt) <= now().getTime())
              throw unavailable();
            credentials = await client.token(
              initial.connection.target.kind === 'shopify'
                ? initial.connection.target.shop
                : '',
              { refresh_token: oauth.refreshToken },
            );
            if (
              !shopifyScopes.every((scope) =>
                credentials.shopify!.scopes.includes(scope),
              )
            )
              throw unavailable();
          } catch (error) {
            if (
              !(error instanceof ConnectorError) ||
              error.failure.code !== 'authentication'
            )
              throw error;
            await persist(
              tx,
              record,
              { ...next(record, 'revoked'), granted: [] },
              null,
              context.actor.id,
              'shopify_authorization_revoked',
            );

            return null;
          }
          await persist(
            tx,
            record,
            {
              ...next(record, 'active'),
              credentialVersion: record.connection.credentialVersion + 1,
            },
            credentials,
            context.actor.id,
            'shopify_token_refreshed',
          );

          return credentials;
        },
      );
      if (!outcome) throw unavailable();

      return outcome;
    },
    async uninstall(
      tenantId: string,
      id: string,
      body: Buffer,
      signature: string,
      shop: string,
      topic: string,
    ) {
      if (
        topic !== 'app/uninstalled' ||
        !shopHostname.safeParse(shop).success ||
        !validMac(config.clientSecret, body, signature, 'base64')
      )
        throw new IdentityError(403, 'FORBIDDEN', 'Invalid Shopify signature');
      const payload = z
        .object({ myshopify_domain: z.literal(shop) })
        .safeParse(JSON.parse(body.toString('utf8')));
      if (!payload.success) throw invalid();
      await locked(tenantId, shop, async (tx) => {
        const record = await scoped(tx, tenantId).get(tenantId, id);
        if (
          !record?.secret ||
          record.connection.target.kind !== 'shopify' ||
          record.connection.target.shop !== shop
        )
          return;
        let credentials = deps.cipher.open(
          record.secret,
          secretBinding(record.connection),
        );
        if (credentials.shopify?.app !== app) return;
        // A delayed uninstall must not revoke a subsequent reinstall, even after token expiry.
        let rotated = false;
        try {
          if (
            Date.parse(credentials.shopify.expiresAt) <=
            now().getTime() + 60000
          ) {
            if (
              Date.parse(credentials.shopify.refreshExpiresAt) <=
              now().getTime()
            )
              throw unavailable();
            credentials = await client.token(shop, {
              refresh_token: credentials.shopify.refreshToken,
            });
            rotated = true;
          }
          await deps.verify(record.connection, credentials);
          if (rotated)
            await persist(
              tx,
              record,
              {
                ...next(record, record.connection.status),
                credentialVersion: record.connection.credentialVersion + 1,
              },
              credentials,
              'shopify',
              'shopify_token_refreshed',
            );

          return;
        } catch (error) {
          if (
            !(error instanceof ConnectorError) ||
            error.failure.code !== 'authentication'
          )
            throw error;
        }
        await persist(
          tx,
          record,
          { ...next(record, 'revoked'), granted: [] },
          null,
          'shopify',
          'shopify_uninstalled',
        );
      });
    },
  };
}

export type ShopifyOAuth = ReturnType<typeof createShopifyOAuth>;

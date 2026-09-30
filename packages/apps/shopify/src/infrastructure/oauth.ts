import { createHash, randomBytes, randomUUID } from 'node:crypto';

import {
  ConnectorError,
  type InstallationCredentials,
  type InstallationDependencies,
  type InstalledConnection,
  secretBinding,
  type StoredInstallation,
} from '@luma/connections';
import { createInstallationRepository } from '@luma/connections/composition';
import {
  callbackParams,
  createClient,
  createOAuthClient,
  parse,
  shopHostname,
  shopifyScopes,
  validMac,
} from '@luma/connector-shopify';
import type { TenantContext } from '@luma/identity';
import { IdentityError, requireRole } from '@luma/identity';
import type { SqlTransaction, TenantDatabase } from '@luma/platform';
import { z } from 'zod';

import type { ShopifyAppConfig as ShopifyConfig } from '../application/oauth.js';
import { storedCredentials } from './installation-validation.js';
import { mapShopifyWebhook } from './webhooks.js';

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

// Record changes schedule fresh reads; periodic scans recover any missed delivery.
const changeTopics = [
  'ORDERS_CREATE',
  'ORDERS_UPDATED',
  'ORDERS_DELETE',
  'FULFILLMENTS_CREATE',
  'FULFILLMENTS_UPDATE',
  'PRODUCTS_CREATE',
  'PRODUCTS_UPDATE',
  'PRODUCTS_DELETE',
  'INVENTORY_LEVELS_UPDATE',
] as const;

const customerTopics = ['CUSTOMERS_CREATE', 'CUSTOMERS_UPDATE'] as const;

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
  > & {
    fetch?: typeof globalThis.fetch;
    now?: () => Date;
    requireInstalled?: (context: TenantContext) => Promise<number>;
  },
) {
  const now = deps.now ?? (() => new Date());
  const app = appBinding(config);
  const oauthClient = createOAuthClient(config, deps.fetch, now);
  const client = {
    async token(
      ...args: Parameters<typeof oauthClient.token>
    ): Promise<ReturnType<typeof storedCredentials.parse>> {
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
    requireApp = true,
  ) {
    return db.transaction(tenantId, async (tx) => {
      // Hold app state before connection locks and provider token rotation.
      if (requireApp && deps.requireInstalled) {
        const installation = await tx.query(
          "SELECT app_id FROM workspace_apps WHERE tenant_id=$1 AND app_id='shopify' AND status='installed' FOR SHARE",
          [tenantId],
        );
        if (!installation.rowCount) throw invalid();
      }
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

  async function registerLifecycleWebhooks(
    connection: InstalledConnection,
    credentials: InstallationCredentials,
  ) {
    if (connection.target.kind !== 'shopify') throw invalid();
    const request = createClient({
      shop: connection.target.shop!,
      accessToken: async () => credentials.token,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
    });
    const topics = [
      'APP_UNINSTALLED',
      'APP_SCOPES_UPDATE',
      ...changeTopics,
      ...(config.protectedCustomerDataApproved ? customerTopics : []),
    ] as const;
    for (const topic of topics) {
      const lifecycle =
        topic === 'APP_UNINSTALLED' || topic === 'APP_SCOPES_UPDATE';
      const url = new URL(config.callbackUrl);
      url.pathname = `/api/v1/shopify/changes/${connection.tenantId}/${connection.id}`;
      if (topic === 'APP_UNINSTALLED')
        url.pathname = `/api/v1/shopify/uninstall/${connection.tenantId}/${connection.id}`;
      if (topic === 'APP_SCOPES_UPDATE')
        url.pathname = `/api/v1/shopify/scopes/${connection.tenantId}/${connection.id}`;
      try {
        // Shopify rejects identical subscriptions; list first so reconnect remains idempotent.
        const subscriptions = parse(
          z.object({
            webhookSubscriptions: z.object({
              nodes: z.array(z.object({ uri: z.string() })),
            }),
          }),
          await request(
            `query LumaLifecycleSubscriptions { webhookSubscriptions(first: 100, topics: [${topic}]) { nodes { uri } } }`,
            {},
          ),
        );
        if (
          subscriptions.webhookSubscriptions.nodes.some(
            (s) => s.uri === url.href,
          )
        )
          continue;
        const result = parse(
          z.object({
            webhookSubscriptionCreate: z.object({
              webhookSubscription: z.object({ id: z.string() }).nullable(),
              userErrors: z.array(z.object({ message: z.string() })),
            }),
          }),
          await request(
            `mutation LumaLifecycleWebhook($uri: String!) { webhookSubscriptionCreate(topic: ${topic}, webhookSubscription: { uri: $uri, format: JSON }) { webhookSubscription { id } userErrors { message } } }`,
            { uri: url.href },
          ),
        );
        if (
          !result.webhookSubscriptionCreate.webhookSubscription ||
          result.webhookSubscriptionCreate.userErrors.length
        )
          throw unavailable();
      } catch (error) {
        // Change notifications only speed up sync; scheduled reads still cover their records.
        if (lifecycle) throw error;
      }
    }
  }

  const permissions = [
    ...shopifyReads,
    ...(config.protectedCustomerDataApproved
      ? ['customers.read' as const]
      : []),
  ];

  const requestedScopes = [
    ...shopifyScopes,
    'write_merchant_managed_fulfillment_orders',
    'write_third_party_fulfillment_orders',
    'read_returns',
    'read_locations',
    ...(config.protectedCustomerDataApproved ? ['read_customers'] : []),
    ...(config.allOrdersApproved ? ['read_all_orders'] : []),
  ];

  return {
    config: { webOrigin: config.webOrigin },
    async access(context: TenantContext, connectionId?: string) {
      const fresh = await deps.refreshContext(context);
      const installationVersion = await deps.requireInstalled?.(fresh);
      let scopes: string[] | null = null;
      if (connectionId) {
        const record = await repository.get(fresh.tenantId, connectionId);
        if (
          !record ||
          record.connection.target.kind !== 'shopify' ||
          (installationVersion !== undefined &&
            record.connection.appInstallationVersion !== installationVersion)
        )
          throw new IdentityError(
            404,
            'NOT_FOUND',
            'Shopify connection not found',
          );
        if (record.secret) {
          const credentials = storedCredentials.parse(
            deps.cipher.open(record.secret, secretBinding(record.connection)),
          );
          if (credentials.shopify?.app === app)
            scopes = credentials.shopify.scopes;
        }
      }

      return {
        customerDataApproved: config.protectedCustomerDataApproved === true,
        allOrdersApproved: config.allOrdersApproved === true,
        requestedScopes,
        grantedScopes: scopes,
        missingScopes: connectionId
          ? requestedScopes.filter((scope) => !scopes?.includes(scope))
          : [],
      };
    },
    async start(context: TenantContext, input: unknown) {
      const fresh = await deps.refreshContext(context);
      requireRole(fresh, ['owner', 'admin']);
      const installationVersion = await deps.requireInstalled?.(fresh);
      const stateApp = `${app}:${installationVersion ?? 0}`;
      const parsed = oauthStartInput.safeParse(input);
      if (!parsed.success) throw invalid();
      const { shop, label } = parsed.data;
      const state = `${fresh.tenantId}.${randomBytes(32).toString('hex')}`;
      await db.transaction(fresh.tenantId, async (tx) => {
        await tx.query(
          'DELETE FROM shopify_oauth_states WHERE tenant_id=$1 AND (expires_at < now() OR (actor_id=$2 AND app=$3 AND shop=$4))',
          [fresh.tenantId, fresh.actor.id, stateApp, shop],
        );
        await tx.query(
          'INSERT INTO shopify_oauth_states(tenant_id,digest,actor_id,session_id,app,shop,label,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
          [
            fresh.tenantId,
            digest(state),
            fresh.actor.id,
            fresh.actor.sessionId,
            stateApp,
            shop,
            label,
            new Date(now().getTime() + 600000),
          ],
        );
      });
      const url = new URL(`https://${shop}/admin/oauth/authorize`);
      url.search = new URLSearchParams({
        client_id: config.clientId,
        scope: requestedScopes.join(','),
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
      const installationVersion = await deps.requireInstalled?.(fresh);
      const stateApp = `${app}:${installationVersion ?? 0}`;
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
            stateApp,
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
          appId: 'shopify',
          management: [],
          provider: 'shopify',
          ...(installationVersion
            ? { appInstallationVersion: installationVersion }
            : {}),
          label: attempt.label,
          permissions: [
            ...permissions,
            'fulfillment.hold.release',
            'fulfillment.open',
            'fulfillment.move',
          ],
          granted: [],
          status: 'degraded',
          version: (record?.connection.version ?? 0) + 1,
          credentialVersion: (record?.connection.credentialVersion ?? 0) + 1,
          createdAt: record?.connection.createdAt ?? timestamp,
          updatedAt: timestamp,
        };
        // Persist degraded credentials too, so a scope failure has a recoverable connection.
        try {
          await registerLifecycleWebhooks(connection, credentials);
          if (
            shopifyScopes.every((scope) =>
              credentials.shopify!.scopes.includes(scope),
            )
          ) {
            connection.granted = await deps.verify(connection, credentials);
            if (shopifyReads.every((cap) => connection.granted.includes(cap)))
              connection.status = 'active';
          }
        } catch {
          connection.granted = [];
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
        initial.connection.target.shop!,
        async (tx) => {
          const record = await scoped(tx, context.tenantId).get(
            context.tenantId,
            id,
          );
          if (!record?.secret || record.connection.status !== 'active')
            return null;
          let credentials = storedCredentials.parse(
            deps.cipher.open(record.secret, secretBinding(record.connection)),
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
                ? initial.connection.target.shop!
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
    async changed(
      tenantId: string,
      id: string,
      body: Buffer,
      signature: string,
      shop: string,
      topic: string,
      eventId: string,
    ) {
      if (
        !shopHostname.safeParse(shop).success ||
        !validMac(config.clientSecret, body, signature, 'base64')
      )
        throw new IdentityError(
          401,
          'UNAUTHENTICATED',
          'Invalid Shopify signature',
        );
      const record = await repository.get(tenantId, id);
      // Deliveries for removed or reassigned connections are acknowledged and ignored.
      if (
        !record ||
        record.connection.target.kind !== 'shopify' ||
        record.connection.target.shop !== shop
      )
        return;
      let hint: ReturnType<typeof mapShopifyWebhook>;
      try {
        hint = mapShopifyWebhook({
          tenantId,
          connectionId: id,
          expectedShop: shop,
          shop,
          secret: config.clientSecret,
          hmac: signature,
          eventId,
          topic,
          body,
        });
      } catch {
        throw invalid();
      }
      if (!hint) return;
      await db.transaction(tenantId, async (tx) => {
        await tx.query(
          `INSERT INTO connector_refresh_hints(tenant_id,connection_id,event_key,capabilities)
          VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
          [tenantId, id, hint.eventKey, hint.capabilities],
        );
      });
    },
    async scopesUpdated(
      tenantId: string,
      id: string,
      body: Buffer,
      signature: string,
      shop: string,
      topic: string,
    ) {
      if (
        topic !== 'app/scopes_update' ||
        !shopHostname.safeParse(shop).success ||
        !validMac(config.clientSecret, body, signature, 'base64')
      )
        throw new IdentityError(
          401,
          'UNAUTHENTICATED',
          'Invalid Shopify signature',
        );
      let retryError: unknown;
      await locked(
        tenantId,
        shop,
        async (tx) => {
          const record = await scoped(tx, tenantId).get(tenantId, id);
          if (
            !record?.secret ||
            record.connection.target.kind !== 'shopify' ||
            record.connection.target.shop !== shop
          )
            return;
          let credentials = storedCredentials.parse(
            deps.cipher.open(record.secret, secretBinding(record.connection)),
          );
          if (credentials.shopify?.app !== app) return;
          let rotated = false;
          try {
            if (
              Date.parse(credentials.shopify.expiresAt) <=
              now().getTime() + 60000
            ) {
              credentials = await client.token(shop, {
                refresh_token: credentials.shopify.refreshToken,
              });
              rotated = true;
            }
            const request = createClient({
              shop,
              accessToken: async () => credentials.token,
              ...(deps.fetch ? { fetch: deps.fetch } : {}),
            });
            const access = parse(
              z.object({
                currentAppInstallation: z.object({
                  accessScopes: z.array(z.object({ handle: z.string() })),
                }),
              }),
              await request(
                'query LumaScopeUpdate { currentAppInstallation { accessScopes { handle } } }',
                {},
              ),
            );
            credentials.shopify!.scopes =
              access.currentAppInstallation.accessScopes.map(
                (scope) => scope.handle,
              );
            const granted = await deps.verify(record.connection, credentials);
            const active =
              shopifyScopes.every((scope) =>
                credentials.shopify!.scopes.includes(scope),
              ) && shopifyReads.every((cap) => granted.includes(cap));
            await persist(
              tx,
              record,
              {
                ...next(record, active ? 'active' : 'degraded'),
                granted,
                credentialVersion: record.connection.credentialVersion + 1,
              },
              credentials,
              'shopify',
              'shopify_scopes_updated',
            );
          } catch (error) {
            if (
              !(error instanceof ConnectorError) ||
              !['authentication', 'permission_denied'].includes(
                error.failure.code,
              )
            ) {
              if (!rotated) throw error;
              // Commit the rotated token before asking Shopify to retry a failed grant probe.
              await persist(
                tx,
                record,
                {
                  ...next(record, 'degraded'),
                  granted: [],
                  credentialVersion: record.connection.credentialVersion + 1,
                },
                credentials,
                'shopify',
                'shopify_scope_check_failed',
              );
              retryError = error;

              return;
            }
            const revoked = error.failure.code === 'authentication';
            await persist(
              tx,
              record,
              {
                ...next(record, revoked ? 'revoked' : 'degraded'),
                granted: [],
                credentialVersion:
                  record.connection.credentialVersion + (rotated ? 1 : 0),
              },
              revoked ? null : credentials,
              'shopify',
              'shopify_scopes_updated',
            );
          }
        },
        false,
      );
      if (retryError) throw retryError;
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
      await locked(
        tenantId,
        shop,
        async (tx) => {
          const record = await scoped(tx, tenantId).get(tenantId, id);
          if (
            !record?.secret ||
            record.connection.target.kind !== 'shopify' ||
            record.connection.target.shop !== shop
          )
            return;
          let credentials = storedCredentials.parse(
            deps.cipher.open(record.secret, secretBinding(record.connection)),
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
        },
        false,
      );
    },
  };
}

export type ShopifyOAuth = ReturnType<typeof createShopifyOAuth>;

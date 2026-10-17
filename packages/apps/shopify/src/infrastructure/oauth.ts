import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { shopifyAccessSchema } from '@luma/api-contract';
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
  type BudgetStore,
  callbackParams,
  createClient,
  createOAuthClient,
  parse,
  shopHostname,
  shopifyScopes,
  validMac,
} from '@luma/connector-shopify';
import type { TenantContext } from '@luma/identity';
import type { SqlTransaction, TenantDatabase } from '@luma/platform';
import { conflict, forbidden, notFound, ServiceError } from '@luma/platform';
import { z } from 'zod';

import type { ShopifyAppConfig as ShopifyConfig } from '../application/oauth.js';
import { storedCredentials } from '../domain/installation-validation.js';
import { shopifyRequestBudget } from './request-budget.js';
import {
  canSubscribe,
  mapShopifyWebhook,
  shopifyChangeTopics,
} from './webhooks.js';

const invalid = () =>
  new ServiceError(
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

const oauthStartInput = z
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
  > & {
    requestBudgetStore?: BudgetStore | undefined;
    env?: Readonly<Record<string, string | undefined>>;
    fetch?: typeof globalThis.fetch;
    now?: () => Date;
    requireInstalled?: (context: TenantContext) => Promise<number>;
    /** Requires permission to connect stores; the host checks it with app installation. */
    authorize(context: TenantContext): Promise<void>;
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
      throw conflict('Connection changed. Connect again.');
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
    tx: SqlTransaction,
  ) {
    if (connection.target.kind !== 'shopify') throw invalid();
    const request = createClient({
      budget: shopifyRequestBudget(
        {
          requestBudgetStore: deps.requestBudgetStore,
          env: {
            ...deps.env,
            SHOPIFY_APP_ENVIRONMENT: config.environment,
            SHOPIFY_CLIENT_ID: config.clientId,
          },
        },
        connection,
      ),
      shop: connection.target.shop!,
      accessToken: async () => credentials.token,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
    });
    const topics = [
      'APP_UNINSTALLED',
      'APP_SCOPES_UPDATE',
      ...Object.keys(shopifyChangeTopics).map((topic) =>
        topic.replaceAll('/', '_').toUpperCase(),
      ),
    ];
    const scopes = storedCredentials.parse(credentials).shopify?.scopes ?? [];
    for (const topic of topics) {
      const changeTopic = Object.keys(shopifyChangeTopics).find(
        (value) => value.replaceAll('/', '_').toUpperCase() === topic,
      );
      const saveHealth = async (
        status: 'registered' | 'failed' | 'unavailable',
      ) => {
        if (!changeTopic) return;
        await tx.query(
          `INSERT INTO shopify_change_subscriptions(tenant_id,connection_id,topic,status,checked_at)
          VALUES($1,$2,$3,$4,$5) ON CONFLICT(tenant_id,connection_id,topic)
          DO UPDATE SET status=EXCLUDED.status,checked_at=EXCLUDED.checked_at`,
          [
            connection.tenantId,
            connection.id,
            changeTopic,
            status,
            now().toISOString(),
          ],
        );
      };
      if (
        changeTopic &&
        !canSubscribe(
          changeTopic,
          scopes,
          !!config.protectedCustomerDataApproved,
        )
      ) {
        await saveHealth('unavailable');
        continue;
      }
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
            `query LumaLifecycleSubscriptions($uri: String!) { webhookSubscriptions(first: 100, topics: [${topic}], uri: $uri) { nodes { uri } } }`,
            { uri: url.href },
          ),
        );
        if (
          subscriptions.webhookSubscriptions.nodes.some(
            (s) => s.uri === url.href,
          )
        ) {
          await saveHealth('registered');
          continue;
        }
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
        await saveHealth('registered');
      } catch (error) {
        // Change notifications only speed up sync; scheduled reads still cover their records.
        if (lifecycle) throw error;
        await saveHealth('failed');
      }
    }
  }

  // Supplemental reads are optional: missing grants do not disable baseline commerce reads.
  const permissions = [
    ...shopifyReads,
    'inventory.transfers.read' as const,
    'inventory.shipments.read' as const,
    'returns.read' as const,
    'returns.options.read' as const,
    'returns.created.read' as const,
    'returns.create' as const,
    'returns.exchange.options.read' as const,
    'returns.exchange.quote.read' as const,
    'returns.exchange.proof.read' as const,
    'returns.exchange.price.read' as const,
    'returns.exchange.request' as const,
    'returns.exchange.process' as const,
    'returns.exchange.cancel' as const,
    'returns.exchange.release' as const,
    'returns.settlement.quote.read' as const,
    'returns.settlement.proof.read' as const,
    'returns.refund' as const,
    ...(config.protectedCustomerDataApproved
      ? ['customers.read' as const]
      : []),
  ];

  const requestedScopes = [
    ...shopifyScopes,
    'write_inventory',
    'write_merchant_managed_fulfillment_orders',
    'write_third_party_fulfillment_orders',
    'read_returns',
    'write_returns',
    'write_orders',
    'write_order_edits',
    'read_locations',
    'read_inventory_transfers',
    'read_inventory_shipments',
    ...(config.protectedCustomerDataApproved ? ['read_customers'] : []),
    ...(config.allOrdersApproved ? ['read_all_orders'] : []),
  ];

  return {
    config: { webOrigin: config.webOrigin },
    async access(context: TenantContext, connectionId?: string) {
      const fresh = await deps.refreshContext(context);
      const installationVersion = await deps.requireInstalled?.(fresh);
      let scopes: string[] | null = null;
      let subscriptions: {
        topic: string;
        status: string;
        checkedAt: string | null;
        lastReceivedAt: string | null;
      }[] = [];
      if (connectionId) {
        const record = await repository.get(fresh.tenantId, connectionId);
        if (
          !record ||
          record.connection.target.kind !== 'shopify' ||
          (installationVersion !== undefined &&
            record.connection.appInstallationVersion !== installationVersion)
        )
          throw notFound('Shopify connection not found');
        if (record.secret) {
          const credentials = storedCredentials.parse(
            deps.cipher.open(record.secret, secretBinding(record.connection)),
          );
          if (credentials.shopify?.app === app)
            scopes = credentials.shopify.scopes;
        }
      }

      if (connectionId) {
        let installed: Set<string> | null = null;
        const record = await repository.get(fresh.tenantId, connectionId);
        if (record?.secret && record.connection.status === 'active') {
          try {
            const credentials = await this.credential(fresh, connectionId);
            const request = createClient({
              budget: shopifyRequestBudget(
                {
                  requestBudgetStore: deps.requestBudgetStore,
                  env: {
                    ...deps.env,
                    SHOPIFY_APP_ENVIRONMENT: config.environment,
                    SHOPIFY_CLIENT_ID: config.clientId,
                  },
                },
                record.connection,
              ),
              shop: record.connection.target.shop!,
              accessToken: async () => credentials.token,
              ...(deps.fetch ? { fetch: deps.fetch } : {}),
            });
            const url = new URL(config.callbackUrl);
            url.pathname = `/api/v1/shopify/changes/${fresh.tenantId}/${connectionId}`;
            installed = new Set<string>();
            let cursor: string | null = null;
            const seen = new Set<string>();
            do {
              const page: {
                webhookSubscriptions: {
                  nodes: { topic: string; uri: string }[];
                  pageInfo: { hasNextPage: boolean; endCursor: string | null };
                };
              } = parse(
                z.object({
                  webhookSubscriptions: z.object({
                    nodes: z.array(
                      z.object({ topic: z.string(), uri: z.string() }),
                    ),
                    pageInfo: z.object({
                      hasNextPage: z.boolean(),
                      endCursor: z.string().nullable(),
                    }),
                  }),
                }),
                await request(
                  'query LumaSubscriptionHealth($uri: String!, $after: String) { webhookSubscriptions(first: 100, after: $after, uri: $uri) { nodes { topic uri } pageInfo { hasNextPage endCursor } } }',
                  { uri: url.href, after: cursor },
                ),
              );
              for (const node of page.webhookSubscriptions.nodes)
                if (node.uri === url.href) installed.add(node.topic);
              cursor = page.webhookSubscriptions.pageInfo.hasNextPage
                ? page.webhookSubscriptions.pageInfo.endCursor
                : null;
              if (
                page.webhookSubscriptions.pageInfo.hasNextPage &&
                (!cursor || seen.has(cursor) || seen.size >= 100)
              )
                throw unavailable();
              if (cursor) seen.add(cursor);
            } while (cursor);
          } catch {
            installed = null;
          }
        }
        const health = await db.transaction(fresh.tenantId, (tx) =>
          tx.query<{
            topic: string;
            status: string;
            checked_at: Date;
            last_received_at: Date | null;
          }>(
            'SELECT topic,status,checked_at,last_received_at FROM shopify_change_subscriptions WHERE tenant_id=$1 AND connection_id=$2 ORDER BY topic',
            [fresh.tenantId, connectionId],
          ),
        );
        subscriptions = Object.keys(shopifyChangeTopics).map((topic) => {
          const row = health.rows.find((row) => row.topic === topic);

          return {
            topic,
            status:
              !canSubscribe(
                topic,
                scopes ?? [],
                !!config.protectedCustomerDataApproved,
              ) || !installed
                ? 'unavailable'
                : installed.has(topic.replaceAll('/', '_').toUpperCase())
                  ? 'registered'
                  : row?.status === 'failed'
                    ? 'failed'
                    : 'missing',
            checkedAt: installed
              ? now().toISOString()
              : (row?.checked_at.toISOString() ?? null),
            lastReceivedAt: row?.last_received_at?.toISOString() ?? null,
          };
        });
      }

      return shopifyAccessSchema.parse({
        subscriptions,
        customerDataApproved: config.protectedCustomerDataApproved === true,
        allOrdersApproved: config.allOrdersApproved === true,
        requestedScopes,
        grantedScopes: scopes,
        missingScopes: connectionId
          ? requestedScopes.filter((scope) => !scopes?.includes(scope))
          : [],
      });
    },
    async start(context: TenantContext, input: unknown) {
      const fresh = await deps.refreshContext(context);
      await deps.authorize(fresh);
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
      await deps.authorize(fresh);
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
          throw conflict(
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
          throw conflict('Shopify installation is already connected.');
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
            'inventory.available.reconcile',
            'fulfillment.hold.release',
            'fulfillment.open',
            'fulfillment.move',
            'fulfillment.shipment.create',
            'fulfillment.tracking.update',
            'orders.quantity.edit',
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
          await registerLifecycleWebhooks(connection, credentials, tx);
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
        await deps.authorize(await deps.refreshContext(context));
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
        throw new ServiceError(
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
          `INSERT INTO shopify_change_subscriptions(tenant_id,connection_id,topic,status,checked_at,last_received_at) VALUES($1,$2,$3,'missing',$4,$4) ON CONFLICT(tenant_id,connection_id,topic) DO UPDATE SET last_received_at=EXCLUDED.last_received_at`,
          [tenantId, id, topic, now().toISOString()],
        );
        await tx.query(
          `INSERT INTO connector_refresh_hints(tenant_id,connection_id,event_key,capabilities,reconcile)
          VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
          [
            tenantId,
            id,
            hint.eventKey,
            hint.capabilities,
            [
              'orders/delete',
              'products/delete',
              'inventory_items/delete',
              'inventory_levels/disconnect',
              'locations/delete',
            ].includes(topic),
          ],
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
        throw new ServiceError(
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
              budget: shopifyRequestBudget(
                {
                  requestBudgetStore: deps.requestBudgetStore,
                  env: {
                    ...deps.env,
                    SHOPIFY_APP_ENVIRONMENT: config.environment,
                    SHOPIFY_CLIENT_ID: config.clientId,
                  },
                },
                { tenantId, target: { kind: 'shopify', shop } },
              ),
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
        throw forbidden('Invalid Shopify signature');
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

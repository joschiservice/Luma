import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';

import {
  ConnectorError,
  type InstallationCapability,
  type InstallationDependencies,
  type InstalledConnection,
  secretBinding,
  type StoredInstallation,
} from '@luma/connections';
import { simulationTransport } from '@luma/connections/adapters';
import { createInstallationRepository } from '@luma/connections/composition';
import {
  authorizationUrl,
  canRead,
  canSend,
  createOAuthClient,
  type OAuthCredentials,
  readScope,
  sendScope,
} from '@luma/connector-gmail';
import type { TenantContext } from '@luma/identity';
import type { SqlTransaction, TenantDatabase } from '@luma/platform';
import { conflict, notFound, ServiceError } from '@luma/platform';
import { z } from 'zod';

import type { GmailConfig } from '../config.js';
import {
  emailAddress,
  gmailCapabilities,
  gmailReads,
  type StoredCredentials,
  storedCredentials,
} from '../domain/installation-validation.js';

const invalid = () =>
  new ServiceError(
    422,
    'CONFLICT',
    'Gmail authorization expired or is invalid. Connect again.',
  );

const unavailable = () =>
  new ConnectorError({
    code: 'authentication',
    effect: 'none',
    retry: 'never',
  });

const digest = (state: string) =>
  createHash('sha256').update(state).digest('hex');

const statePattern = /^[0-9a-f-]{36}\.[0-9a-f]{64}$/;

const oauthStartInput = z
  .object({
    label: z.string().trim().min(1).max(120),
    loginHint: z.string().trim().toLowerCase().pipe(emailAddress).optional(),
  })
  .strict();

/** Identifies an OAuth application within its configured environment. */
const appBinding = (config: GmailConfig) =>
  `${config.environment}:${config.clientId}`;

/** Google scopes Luma needs for reading and for sending. */
const requestedScopes = [readScope, sendScope];

/** Grants the connection's capabilities that its Google scopes allow. */
function grantsFor(scopes: readonly string[]): InstallationCapability[] {
  if (!canRead(scopes)) return [];

  return [
    ...gmailReads,
    ...(canSend(scopes) ? ['messages.send' as const] : []),
  ];
}

/**
 * Creates tenant-bound Gmail authorization and credential refresh backed by persistent OAuth
 * state. Authorization uses PKCE; the verifier is derived from the state with the client
 * secret, so only a digest of the state is stored.
 */
export function createGmailOAuth(
  db: TenantDatabase,
  config: GmailConfig,
  deps: Pick<
    InstallationDependencies,
    'cipher' | 'refreshContext' | 'verify'
  > & {
    fetch?: typeof globalThis.fetch | undefined;
    /** Routes simulated connections' token refresh to their simulator. */
    simulation?:
      | ((connection: InstalledConnection) => typeof fetch | undefined)
      | undefined;
    now?: () => Date;
    requireInstalled?: (context: TenantContext) => Promise<number>;
    /** Requires permission to connect mailboxes; the host checks it with app installation. */
    authorize(context: TenantContext): Promise<void>;
  },
) {
  const now = deps.now ?? (() => new Date());
  const app = appBinding(config);
  const repository = createInstallationRepository(db);
  const oauthClient = (fetch = deps.fetch) =>
    createOAuthClient(config, fetch ?? globalThis.fetch, now);

  const verifierFor = (state: string) =>
    createHmac('sha256', config.clientSecret)
      .update(`gmail-pkce:${state}`)
      .digest('base64url');

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
    mailbox: string,
    operation: (tx: SqlTransaction) => Promise<T>,
  ) {
    return db.transaction(tenantId, async (tx) => {
      // Hold app state before connection locks and provider token rotation.
      if (deps.requireInstalled) {
        const installation = await tx.query(
          "SELECT app_id FROM workspace_apps WHERE tenant_id=$1 AND app_id='gmail' AND status='installed' FOR SHARE",
          [tenantId],
        );
        if (!installation.rowCount) throw invalid();
      }
      // Serialize token acquisition and refresh across API and worker processes.
      await tx.query(
        "SELECT set_config('statement_timeout','30000',true), set_config('idle_in_transaction_session_timeout','90000',true)",
      );
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        JSON.stringify([app, mailbox]),
      ]);
      await tx.query(
        "SELECT id FROM connector_installations WHERE tenant_id=$1 AND document->'target'->>'kind'='gmail' AND document->'target'->>'emailAddress'=$2 FOR UPDATE",
        [tenantId, mailbox],
      );

      return operation(tx);
    });
  }

  async function persist(
    tx: SqlTransaction,
    record: StoredInstallation | null,
    connection: InstalledConnection,
    credentials: StoredCredentials | null,
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

  const stored = (
    tokens: OAuthCredentials,
    mailbox: string,
    refreshToken: string,
  ): StoredCredentials => ({
    token: tokens.token,
    gmail: {
      app,
      refreshToken,
      expiresAt: tokens.expiresAt,
      scopes: tokens.scopes,
      emailAddress: mailbox,
    },
  });

  function callbackParams(query: string) {
    const params = new URLSearchParams(query);
    if ([...params.keys()].some((key) => params.getAll(key).length !== 1))
      throw invalid();
    const state = params.get('state') ?? '';
    if (!statePattern.test(state)) throw invalid();

    return { params, state };
  }

  return {
    config: { webOrigin: config.webOrigin },
    /** Reports the mailbox and recorded Google grants without exposing credentials. */
    async access(context: TenantContext, connectionId?: string) {
      const fresh = await deps.refreshContext(context);
      const installationVersion = await deps.requireInstalled?.(fresh);
      let scopes: string[] | null = null;
      let mailbox: string | null = null;
      if (connectionId) {
        const record = await repository.get(fresh.tenantId, connectionId);
        if (
          !record ||
          record.connection.target.kind !== 'gmail' ||
          (installationVersion !== undefined &&
            record.connection.appInstallationVersion !== installationVersion)
        )
          throw notFound('Gmail connection not found');
        mailbox = record.connection.target.emailAddress ?? null;
        if (record.secret) {
          const credentials = storedCredentials.parse(
            deps.cipher.open(record.secret, secretBinding(record.connection)),
          );
          if (credentials.gmail?.app === app) scopes = credentials.gmail.scopes;
        }
      }

      return {
        emailAddress: mailbox,
        push: config.push !== undefined,
        requestedScopes,
        grantedScopes: scopes,
        canRead: scopes ? canRead(scopes) : null,
        canSend: scopes ? canSend(scopes) : null,
        missingScopes:
          connectionId && scopes
            ? requestedScopes.filter(
                (scope) =>
                  !(scope === readScope ? canRead(scopes) : canSend(scopes)),
              )
            : [],
      };
    },
    async start(context: TenantContext, input: unknown) {
      const fresh = await deps.refreshContext(context);
      await deps.authorize(fresh);
      const installationVersion = await deps.requireInstalled?.(fresh);
      const stateApp = `${app}:${installationVersion ?? 0}`;
      const parsed = oauthStartInput.safeParse(input);
      if (!parsed.success) throw invalid();
      const { label, loginHint } = parsed.data;
      const state = `${fresh.tenantId}.${randomBytes(32).toString('hex')}`;
      await db.transaction(fresh.tenantId, async (tx) => {
        await tx.query(
          'DELETE FROM gmail_oauth_states WHERE tenant_id=$1 AND (expires_at < now() OR (actor_id=$2 AND session_id=$3 AND app=$4))',
          [fresh.tenantId, fresh.actor.id, fresh.actor.sessionId, stateApp],
        );
        await tx.query(
          'INSERT INTO gmail_oauth_states(tenant_id,digest,actor_id,session_id,app,label,login_hint,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
          [
            fresh.tenantId,
            digest(state),
            fresh.actor.id,
            fresh.actor.sessionId,
            stateApp,
            label,
            loginHint ?? null,
            new Date(now().getTime() + 600000),
          ],
        );
      });

      return {
        authorizationUrl: authorizationUrl(config, {
          state,
          codeVerifier: verifierFor(state),
          loginHint,
        }),
      };
    },
    /** Returns the workspace named by a callback's state, before any session is resolved. */
    callbackTenant(query: string) {
      const { state } = callbackParams(query);

      return z.string().uuid().parse(state.split('.')[0]);
    },
    async callback(context: TenantContext, query: string) {
      const fresh = await deps.refreshContext(context);
      await deps.authorize(fresh);
      const installationVersion = await deps.requireInstalled?.(fresh);
      const stateApp = `${app}:${installationVersion ?? 0}`;
      const { params, state } = callbackParams(query);
      const attempt = await db.transaction(fresh.tenantId, async (tx) => {
        const result = await tx.query<{ label: string }>(
          'DELETE FROM gmail_oauth_states WHERE tenant_id=$1 AND digest=$2 AND actor_id=$3 AND session_id=$4 AND app=$5 AND expires_at > $6 RETURNING label',
          [
            fresh.tenantId,
            digest(state),
            fresh.actor.id,
            fresh.actor.sessionId,
            stateApp,
            now(),
          ],
        );

        return result.rows[0];
      });
      if (!attempt) throw invalid();
      if (params.has('error')) return 'denied' as const;
      const code = params.get('code');
      if (!code || code.length > 4096) throw invalid();

      const tokens = await oauthClient().token({
        code,
        codeVerifier: verifierFor(state),
      });
      const mailbox = emailAddress.safeParse(tokens.emailAddress);
      // Google returns a refresh token on every consent because Luma always asks for consent.
      if (!mailbox.success || !tokens.refreshToken) throw invalid();
      const address = mailbox.data;
      const credentials = stored(tokens, address, tokens.refreshToken);

      return locked(fresh.tenantId, address, async (tx) => {
        const repo = scoped(tx, fresh.tenantId);
        const existing = (await repo.list(fresh.tenantId)).filter(
          (c) => c.target.kind === 'gmail' && c.target.emailAddress === address,
        );
        if (existing.length > 1)
          throw conflict(
            'Disconnect duplicate Gmail connections before reconnecting.',
          );
        const id = existing[0]?.id ?? randomUUID();
        await tx.query(
          'INSERT INTO gmail_mailbox_bindings(tenant_id,app,email_address,connection_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
          [fresh.tenantId, app, address, id],
        );
        // Bindings of other workspaces are invisible here, so a conflict reads as a mismatch.
        const binding = await tx.query<{ connection_id: string }>(
          'SELECT connection_id FROM gmail_mailbox_bindings WHERE tenant_id=$1 AND app=$2 AND email_address=$3',
          [fresh.tenantId, app, address],
        );
        if (binding.rows[0]?.connection_id !== id)
          throw conflict('This mailbox is already connected to a workspace.');
        const record = await repo.get(fresh.tenantId, id);
        const timestamp = now().toISOString();
        const connection: InstalledConnection = {
          id,
          tenantId: fresh.tenantId,
          target: { kind: 'gmail', emailAddress: address },
          appId: 'gmail',
          management: [],
          provider: 'gmail',
          ...(installationVersion
            ? { appInstallationVersion: installationVersion }
            : {}),
          label: attempt.label,
          permissions: [...gmailCapabilities],
          granted: [],
          status: 'degraded',
          version: (record?.connection.version ?? 0) + 1,
          credentialVersion: (record?.connection.credentialVersion ?? 0) + 1,
          createdAt: record?.connection.createdAt ?? timestamp,
          updatedAt: timestamp,
        };
        // Persist credentials without read access too, so reconnecting can repair them.
        try {
          if (canRead(tokens.scopes)) {
            const verified = await deps.verify(connection, credentials);
            const allowed = grantsFor(tokens.scopes);
            connection.granted = verified.filter((cap) =>
              allowed.includes(cap),
            );
            if (gmailReads.every((cap) => connection.granted.includes(cap)))
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
          'gmail_authorized',
        );

        return connection.status === 'active'
          ? ('connected' as const)
          : ('permissions' as const);
      });
    },
    /**
     * Refreshes the access token when it expires within a minute and returns current
     * credentials. A rejected refresh token revokes the connection; temporary failures keep
     * the stored tokens. Token-based fixture credentials are returned unchanged.
     */
    async credential(context: TenantContext, id: string) {
      const initial = await repository.get(context.tenantId, id);
      if (!initial || initial.connection.target.kind !== 'gmail')
        throw unavailable();
      const mailbox = initial.connection.target.emailAddress ?? '';
      const outcome = await locked(context.tenantId, mailbox, async (tx) => {
        const record = await scoped(tx, context.tenantId).get(
          context.tenantId,
          id,
        );
        if (!record?.secret || record.connection.status !== 'active')
          return null;
        const credentials = storedCredentials.parse(
          deps.cipher.open(record.secret, secretBinding(record.connection)),
        );
        if (!credentials.gmail) return credentials;
        const oauth = credentials.gmail;
        if (oauth.app !== app) return null;
        if (Date.parse(oauth.expiresAt) > now().getTime() + 60000)
          return credentials;
        let refreshed: StoredCredentials;
        try {
          // Simulated connections refresh against their simulator, never Google.
          const transport = simulationTransport(
            record.connection,
            deps.simulation,
          );
          const tokens = await oauthClient(transport ?? deps.fetch).token({
            refreshToken: oauth.refreshToken,
          });
          if (!canRead(tokens.scopes)) throw unavailable();
          refreshed = stored(
            tokens,
            oauth.emailAddress,
            tokens.refreshToken ?? oauth.refreshToken,
          );
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
            'gmail_authorization_revoked',
          );

          return null;
        }
        const allowed = grantsFor(refreshed.gmail!.scopes);
        await persist(
          tx,
          record,
          {
            ...next(record, 'active'),
            // Removing send access at Google also removes it here; it returns on reconnect.
            granted: record.connection.granted.filter((cap) =>
              allowed.includes(cap),
            ),
            credentialVersion: record.connection.credentialVersion + 1,
          },
          refreshed,
          context.actor.id,
          'gmail_token_refreshed',
        );

        return refreshed;
      });
      if (!outcome) throw unavailable();

      return outcome;
    },
  };
}

export type GmailOAuth = ReturnType<typeof createGmailOAuth>;

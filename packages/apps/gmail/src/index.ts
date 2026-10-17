import '@luma/identity/http';

import type { AppDefinition, AppFactoryContext } from '@luma/app-host';
import type { ConnectionProvider } from '@luma/connections';
import { simulationTransport } from '@luma/connections/adapters';
import type { SimulationTransport } from '@luma/connections/composition';
import { createQuotaPacer, type QuotaPacer } from '@luma/connector-gmail';
import { IdentityError } from '@luma/identity';
import type { TenantDatabase } from '@luma/platform';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { registerGmailRoutes } from './api/gmail.js';
import { readGmailConfig } from './config.js';
import {
  installationCredentials,
  installationInput,
  installationTarget,
} from './domain/installation-validation.js';
import { createGmailConnector } from './infrastructure/adapter.js';
import { createGmailOAuth, type GmailOAuth } from './infrastructure/oauth.js';
import { createPushIntake } from './infrastructure/push.js';
import { createInstallationVerifier } from './infrastructure/verifier.js';
import { createWatchStore } from './infrastructure/watches.js';

export { createGmailConnector, createInstallationVerifier };

export type { GmailOAuth };

export { outboundMessageId } from './infrastructure/adapter.js';

/**
 * Creates the Gmail connector contribution. Adapters of one mailbox share its quota pacer within
 * this process. With `push` and a database, message reads renew the mailbox's push registration.
 */
export function createGmailProvider(
  options: {
    oauth?: GmailOAuth | undefined;
    fetch?: typeof globalThis.fetch | undefined;
    simulation?: SimulationTransport | undefined;
    push?: { topic: string; database: TenantDatabase } | undefined;
  } = {},
): ConnectionProvider {
  const pacers = new Map<string, QuotaPacer>();
  const pacerOf = (key: string) => {
    let pacer = pacers.get(key);
    if (!pacer) {
      pacer = createQuotaPacer();
      pacers.set(key, pacer);
    }

    return pacer;
  };

  return {
    appId: 'gmail',
    provider: 'gmail',
    targets: ['gmail'],
    recordAccessFailures: true,
    management: options.oauth ? [] : ['check', 'rotate'],
    validate: (value) => installationInput.parse(value),
    credentials: (_target, value) => installationCredentials.parse(value),
    verify: createInstallationVerifier(options),
    ...(options.oauth ? { refreshCredential: options.oauth.credential } : {}),
    manage() {
      if (options.oauth)
        throw new IdentityError(
          422,
          'CONFLICT',
          'Use Connect Gmail to authorize this mailbox',
        );
    },
    async build(context, id, capability, runtime) {
      const current = await runtime.installations.credential(
        context,
        id,
        capability,
      );
      const target = installationTarget.parse(current.connection.target);
      const fetch =
        simulationTransport(current.connection, runtime.simulation) ??
        runtime.fetch ??
        options.fetch;
      const push = options.push;

      return createGmailConnector({
        tenantId: context.tenantId,
        connectionId: id,
        emailAddress: target.emailAddress,
        pacer: pacerOf(`${context.tenantId}:${id}`),
        accessToken: async () =>
          (await runtime.installations.credential(context, id, capability))
            .credentials.token,
        ...(fetch ? { fetch } : {}),
        ...(push
          ? {
              watch: {
                topic: push.topic,
                ...createWatchStore(push.database, context.tenantId, id),
              },
            }
          : {}),
      });
    },
  };
}

/** Registers Gmail message capabilities, Google authorization and push notifications. */
export function createApp(context: AppFactoryContext): AppDefinition {
  const config = readGmailConfig(context.env);
  const verify = createInstallationVerifier({ simulation: context.simulation });
  const oauth = config
    ? createGmailOAuth(context.database, config, {
        cipher: context.cipher,
        refreshContext: context.refreshContext,
        verify,
        simulation: context.simulation,
        requireInstalled: (ctx) => context.requireInstalled(ctx, 'gmail'),
        authorize: (ctx) =>
          context.requirePermission(ctx, {
            app: 'gmail',
            permission: 'connections.manage',
          }),
      })
    : undefined;

  return {
    manifest: {
      id: 'gmail',
      name: 'Gmail',
      description:
        'Connect Gmail mailboxes to read supplier and customer messages that match your inbox rules, and send approved replies.',
      version: '1.0.0',
      category: 'communication',
      ui: ['connections', 'settings'],
      connectionTypes: [{ kind: 'gmail', name: 'Gmail' }],
      permissions: [
        {
          key: 'gmail:messages.send',
          label: 'Send from Gmail',
          description:
            'Send replies from connected Gmail mailboxes, and approve replies others want to send.',
          consequential: true,
        },
      ],
      scopes: [
        'messages.read',
        'messages.send',
        'customers.read',
        'procurement.read',
        'actions.propose',
        'actions.execute',
      ],
      slotAccess: {
        connections: 'connections.manage',
        settings: 'connections.manage',
      },
    },
    connector: createGmailProvider({
      ...(oauth ? { oauth } : {}),
      ...(context.simulation ? { simulation: context.simulation } : {}),
      ...(config?.push
        ? { push: { topic: config.push.topic, database: context.database } }
        : {}),
    }),
    async uninstalled({ tenantId, transaction }) {
      // Releasing the mailbox binding lets another workspace connect the mailbox.
      for (const table of [
        'gmail_oauth_states',
        'gmail_watches',
        'gmail_mailbox_bindings',
      ])
        await transaction.query(`DELETE FROM ${table} WHERE tenant_id=$1`, [
          tenantId,
        ]);
    },
    async ready() {
      return context.database.transaction(
        '00000000-0000-4000-8000-000000000000',
        async (tx) => {
          const present = await tx.query<{ present: boolean }>(
            "SELECT to_regclass('public.gmail_mailbox_bindings') IS NOT NULL AND to_regprocedure('public.gmail_push_hint(text,text,text)') IS NOT NULL AS present",
          );
          if (!present.rows[0]?.present) return false;
          await tx.query('SELECT digest FROM gmail_oauth_states LIMIT 0');
          await tx.query('SELECT connection_id FROM gmail_watches LIMIT 0');

          return true;
        },
      );
    },
    registerHttp(server, identity) {
      registerGmailRoutes(
        server,
        oauth,
        identity,
        createPushIntake(context.database, config),
      );
      // Both operations need connections.manage, the installed app and configured OAuth.
      const authorized = async (
        request: FastifyRequest,
        reply: FastifyReply,
      ) => {
        reply.header('cache-control', 'no-store');
        if (!request.tenantContext)
          throw new IdentityError(
            401,
            'UNAUTHENTICATED',
            'Sign in to continue',
          );
        await context.requireInstalled(request.tenantContext, 'gmail');
        if (!oauth)
          throw new IdentityError(
            503,
            'SERVICE_UNAVAILABLE',
            'Gmail authorization is not configured',
          );

        return { tenant: request.tenantContext, oauth };
      };
      server.post(
        '/v1/organizations/:organizationId/apps/gmail/access',
        { config: { access: { permission: 'connections.manage' } } },
        async (request, reply) => {
          const { tenant, oauth } = await authorized(request, reply);
          const input = z
            .object({ connectionId: z.string().uuid().optional() })
            .strict()
            .parse(request.body);

          return oauth.access(tenant, input.connectionId);
        },
      );
      server.post(
        '/v1/organizations/:organizationId/apps/gmail/authorize',
        { config: { access: { permission: 'connections.manage' } } },
        async (request, reply) => {
          const { tenant, oauth } = await authorized(request, reply);

          return oauth.start(tenant, request.body);
        },
      );
    },
  };
}

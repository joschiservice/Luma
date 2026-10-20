import { conflict, forbidden, invalid, notFound } from '@luma/platform';

import type { ApiAppLifetime, ApiAppStatus } from '../domain/api-apps.js';
import {
  apiAppLifetimes,
  apiAppScopesFor,
  readsPersonalData,
  recordsRead,
  workspaceRoute,
} from '../domain/api-apps.js';
import type { Membership, TenantContext } from '../domain/context.js';
import {
  requireActiveMembership,
  requireChangesAllowed,
} from '../domain/context.js';

/** A stored personal API app with its newest credential. */
export interface ApiAppRecord {
  id: string;
  userId: string;
  name: string;
  scopes: string[];
  createdAt: string;
  revokedAt: string | null;
  credential: {
    id: string;
    lastFour: string;
    createdAt: string;
    expiresAt: string;
    lastUsedAt: string | null;
    revokedAt: string | null;
  } | null;
  /**
   * Requests in the last `apiAppReadWindowDays` days that read customer personal data, and the
   * records they returned.
   */
  personalReads: { requests: number; records: number };
}

/** An API app as callers see it; never its token or token hash. */
export interface ApiAppDto {
  id: string;
  name: string;
  scopes: string[];
  status: ApiAppStatus;
  owner: { userId: string; name: string | null };
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  lastFour: string | null;
  revokedAt: string | null;
  personalDataReads: { requests: number; records: number };
}

/**
 * The credential behind a bearer token, read without tenant context. `status` is computed in
 * the database from revocation and expiry at read time.
 */
export interface ApiCredential {
  id: string;
  tenantId: string;
  appId: string;
  userId: string;
  scopes: string[];
  status: ApiAppStatus;
}

/**
 * Finds credentials for bearer requests. `resolve` checks the token's format and cell before
 * looking up its hash, and records use at most once a minute; `find` rereads a credential by ID
 * when a context is refreshed; `admit` applies rate limits.
 */
export interface ApiCredentials {
  resolve(
    token: string,
  ): Promise<
    | { state: 'invalid' }
    | { state: 'other_cell' }
    | { state: 'found'; credential: ApiCredential }
  >;
  find(tenantId: string, credentialId: string): Promise<ApiCredential | null>;
  /**
   * Counts one request against the credential's and the workspace's limits and reports the
   * one with fewer requests left; null when limits are off.
   */
  admit(tenantId: string, credentialId: string): Promise<ApiRateLimit | null>;
}

/**
 * The tighter of an API app's two limits after counting a request: the window's maximum, the
 * requests left in it and the seconds until it resets. `remaining` below zero means refused.
 */
export interface ApiRateLimit {
  limit: number;
  remaining: number;
  reset: number;
}

/** Storage for API app management inside one serialized workspace transaction. */
export interface ApiAppsTransaction {
  member(userId: string): Promise<Membership | null>;
  /** Lists apps, newest first: one member's when `userId` is given, otherwise every app. */
  list(
    userId: string | null,
  ): Promise<(ApiAppRecord & { ownerName: string | null })[]>;
  app(
    id: string,
  ): Promise<(ApiAppRecord & { ownerName: string | null }) | null>;
  /** Counts the member's apps that are not revoked. */
  openCount(userId: string): Promise<number>;
  saveApp(app: {
    id: string;
    userId: string;
    name: string;
    scopes: string[];
  }): Promise<void>;
  /** Stores a new credential and revokes the app's earlier ones. */
  saveCredential(credential: {
    id: string;
    appId: string;
    hash: string;
    lastFour: string;
    expiresAt: string;
  }): Promise<void>;
  /** Revokes the app and every credential it has. */
  revoke(appId: string, actorId: string): Promise<void>;
  /** Queues the email telling the person an app acts for that someone else revoked it. */
  notifyRevoked(appId: string, userId: string): Promise<void>;
  command(
    id: string,
  ): Promise<{ actorId: string; request: unknown; result: unknown } | null>;
  saveCommand(
    id: string,
    actorId: string,
    request: string,
    result: unknown,
  ): Promise<void>;
  audit(
    actorId: string,
    type: string,
    target: string,
    before: unknown,
    after: unknown,
  ): Promise<void>;
}

export interface ApiAppsRepository {
  /** Runs a serialized workspace transaction; read-only requests open it `READ ONLY`. */
  transaction<T>(
    tenantId: string,
    userId: string,
    operation: (tx: ApiAppsTransaction) => Promise<T>,
  ): Promise<T>;
}

/** One API app request that read customer personal data. */
export interface PersonalRead {
  tenantId: string;
  userId: string;
  appId: string;
  credentialId: string;
  /** The route template below the workspace, such as `/customers`. */
  route: string;
  records: number;
}

/**
 * Records personal data reads in their own short transaction, outside the workspace lock:
 * hourly counts per credential and route, and an access event for the first read of each.
 */
export interface ApiAppReads {
  record(read: PersonalRead): Promise<void>;
}

export interface ApiAppsDependencies {
  repository: ApiAppsRepository;
  reads: ApiAppReads;
  /** Creates a token for this cell with its storage hash and last four characters. */
  issue(): { token: string; hash: string; lastFour: string };
  id(): string;
  now(): Date;
}

/** People keep at most this many apps that are not revoked in one workspace. */
export const maxOpenApiApps = 25;

const dayMs = 86_400_000;

function status(app: ApiAppRecord, now: Date): ApiAppStatus {
  if (app.revokedAt) return 'revoked';
  if (
    !app.credential ||
    app.credential.revokedAt ||
    Date.parse(app.credential.expiresAt) <= now.getTime()
  )
    return 'expired';

  return 'active';
}

function dto(
  app: ApiAppRecord & { ownerName: string | null },
  now: Date,
): ApiAppDto {
  return {
    id: app.id,
    name: app.name,
    scopes: app.scopes,
    status: status(app, now),
    owner: { userId: app.userId, name: app.ownerName },
    createdAt: app.createdAt,
    expiresAt: app.credential?.expiresAt ?? null,
    lastUsedAt: app.credential?.lastUsedAt ?? null,
    lastFour: app.credential?.lastFour ?? null,
    revokedAt: app.revokedAt,
    personalDataReads: app.personalReads,
  };
}

function lifetime(days: number): ApiAppLifetime {
  const match = apiAppLifetimes.find((value) => value === days);
  if (!match) throw invalid('Choose how long the token stays valid.');

  return match;
}

/** Bounded values recorded in access events: never the token or its hash. */
function audited(app: {
  name: string;
  userId: string;
  scopes: string[];
  expiresAt?: string | null;
}) {
  return {
    name: app.name,
    userId: app.userId,
    scopes: app.scopes,
    ...(app.expiresAt ? { expiresAt: app.expiresAt } : {}),
  };
}

/**
 * Manages personal API apps: tokens that act for the member who created them, limited to the
 * permissions they chose. Every command rechecks the member inside a serialized workspace
 * transaction, refuses support views and API apps themselves, and records an access event.
 * Tokens are returned once and never stored; a retried command returns the app without it.
 */
export function createApiAppsService(deps: ApiAppsDependencies) {
  async function authorized<T>(
    context: TenantContext,
    operation: (tx: ApiAppsTransaction, actor: Membership) => Promise<T>,
  ) {
    if (context.apiApp)
      throw forbidden('API apps can’t manage API apps. Sign in to Luma.');

    return deps.repository.transaction(
      context.tenantId,
      context.actor.id,
      async (tx) => {
        const actor = await tx.member(context.actor.id);
        if (!actor) throw notFound('Workspace not found');
        requireActiveMembership(actor);

        return operation(tx, actor);
      },
    );
  }

  async function command<T>(
    context: TenantContext,
    input: { commandId: string; [field: string]: unknown },
    kind: string,
    operation: (tx: ApiAppsTransaction, actor: Membership) => Promise<T>,
    stored: (result: T) => unknown = (result) => result,
  ): Promise<T> {
    requireChangesAllowed(context);

    return authorized(context, async (tx, actor) => {
      const request = JSON.stringify({ kind, ...input });
      const previous = await tx.command(input.commandId);
      if (previous) {
        if (
          previous.actorId !== context.actor.id ||
          previous.request !== request
        )
          throw conflict(
            'This request ID was already used. Refresh before trying again.',
          );

        return previous.result as T;
      }
      const result = await operation(tx, actor);
      await tx.saveCommand(
        input.commandId,
        context.actor.id,
        request,
        stored(result),
      );

      return result;
    });
  }

  // Receipts keep the app but never the token: a retry after an uncertain response returns
  // `token: null`, and the person rotates the app to get a new one.
  const withoutToken = (result: { app: ApiAppDto; token: string | null }) => ({
    ...result,
    token: null,
  });

  async function issue(
    tx: ApiAppsTransaction,
    appId: string,
    days: ApiAppLifetime,
  ) {
    const { token, hash, lastFour } = deps.issue();
    const expiresAt = new Date(
      deps.now().getTime() + days * dayMs,
    ).toISOString();
    await tx.saveCredential({
      id: deps.id(),
      appId,
      hash,
      lastFour,
      expiresAt,
    });

    return { token, expiresAt };
  }

  async function current(tx: ApiAppsTransaction, appId: string) {
    const app = await tx.app(appId);
    if (!app) throw notFound('API app not found');

    return app;
  }

  return {
    /**
     * Lists API apps: everyone sees their own, and people with `apps.manage` see every app in
     * the workspace so they can revoke them.
     */
    list(context: TenantContext) {
      return authorized(context, async (tx, actor) =>
        (
          await tx.list(
            actor.permissions.has('apps.manage') ? null : actor.userId,
          )
        ).map((app) => dto(app, deps.now())),
      );
    },
    /**
     * Creates an app acting for the caller with scopes they hold, and returns its token once.
     * Requires `api_apps.create`; a member keeps at most `maxOpenApiApps` apps.
     */
    create(
      context: TenantContext,
      input: {
        commandId: string;
        name: string;
        scopes: string[];
        lifetimeDays: number;
      },
    ) {
      return command(
        context,
        input,
        'api_app.create',
        async (tx, actor) => {
          if (!actor.permissions.has('api_apps.create'))
            throw forbidden(
              'Your role does not allow this. Ask a workspace admin for access.',
            );
          const name = input.name.trim();
          if (!name || name.length > 80)
            throw invalid('Name the app in 1 to 80 characters.');
          const scopes = apiAppScopesFor(input.scopes, actor.permissions);
          const days = lifetime(input.lifetimeDays);
          if ((await tx.openCount(actor.userId)) >= maxOpenApiApps)
            throw conflict(
              `You can have up to ${maxOpenApiApps} API apps. Revoke one you no longer use.`,
            );
          const id = deps.id();
          await tx.saveApp({ id, userId: actor.userId, name, scopes });
          const { token, expiresAt } = await issue(tx, id, days);
          await tx.audit(
            actor.userId,
            'api_app.created',
            id,
            null,
            audited({ name, userId: actor.userId, scopes, expiresAt }),
          );

          return { app: dto(await current(tx, id), deps.now()), token };
        },
        withoutToken,
      );
    },
    /**
     * Replaces the app's token with a new one and returns it once; the old token stops working
     * immediately. Only the person the app acts for can rotate it, and only while they may
     * create API apps. Revoked apps stay revoked.
     */
    rotate(
      context: TenantContext,
      appId: string,
      input: { commandId: string; lifetimeDays: number },
    ) {
      return command(
        context,
        { ...input, appId },
        'api_app.rotate',
        async (tx, actor) => {
          const app = await current(tx, appId);
          if (app.userId !== actor.userId)
            throw forbidden(
              'Only the person an API app acts for can rotate it.',
            );
          if (!actor.permissions.has('api_apps.create'))
            throw forbidden(
              'Your role does not allow this. Ask a workspace admin for access.',
            );
          if (app.revokedAt)
            throw conflict('This API app was revoked. Create a new one.');
          const { token, expiresAt } = await issue(
            tx,
            appId,
            lifetime(input.lifetimeDays),
          );
          await tx.audit(
            actor.userId,
            'api_app.rotated',
            appId,
            { expiresAt: app.credential?.expiresAt ?? null },
            audited({ ...app, expiresAt }),
          );

          return { app: dto(await current(tx, appId), deps.now()), token };
        },
        withoutToken,
      );
    },
    /**
     * Revokes the app and its tokens for good. The person the app acts for and people with
     * `apps.manage` can revoke it; revoking a revoked app changes nothing. When someone else
     * revokes it, the person it acted for is emailed.
     */
    revoke(
      context: TenantContext,
      appId: string,
      input: { commandId: string },
    ) {
      return command(
        context,
        { ...input, appId },
        'api_app.revoke',
        async (tx, actor) => {
          const app = await current(tx, appId);
          if (
            app.userId !== actor.userId &&
            !actor.permissions.has('apps.manage')
          )
            throw notFound('API app not found');
          if (!app.revokedAt) {
            await tx.revoke(appId, actor.userId);
            if (app.userId !== actor.userId)
              await tx.notifyRevoked(appId, app.userId);
            await tx.audit(
              actor.userId,
              'api_app.revoked',
              appId,
              audited(app),
              { revoked: true },
            );
          }

          return dto(await current(tx, appId), deps.now());
        },
      );
    },
    /**
     * Records that an API app read a route that can return customer personal data, when the
     * app can read customers: the route and how many records it returned, never the records.
     * Other contexts record nothing.
     */
    async recordPersonalRead(
      context: TenantContext,
      route: string,
      body: unknown,
    ) {
      if (!context.apiApp || !readsPersonalData(context.permissions)) return;
      await deps.reads.record({
        tenantId: context.tenantId,
        userId: context.actor.id,
        appId: context.apiApp.id,
        credentialId: context.apiApp.credentialId,
        route: workspaceRoute(route),
        records: recordsRead(body),
      });
    },
  };
}

export type ApiAppsService = ReturnType<typeof createApiAppsService>;

# Workspace apps

Apps are trusted first-party packages in `packages/apps/<app-id>` that a workspace
installs. An app owns its provider settings, validation, adapters, OAuth, webhooks,
configuration and UI; core never imports a provider implementation or branches on
provider IDs. Installation, permissions and uninstall are tenant-scoped and transactional,
and an app acts only within the access its installation was granted. Tools outside Luma use
[API apps](identity.md#api-apps) instead: bearer tokens on public routes, owned by identity.

## Ownership

- `@luma/app-host`: registration, installation lifecycle, tenant authorization, lifecycle
  events and UI contribution contracts.
- `@luma/app-catalog`: deployment composition. Its generated module is the only production
  list of app package imports.
- `@luma/connections`: encrypted credentials, connection lifecycle, normalized
  capabilities, observations and execution bridges; provider behavior is injected (see
  [installed connections](installed-connections.md)).
- `packages/connectors/*`: provider protocol clients shared by apps and simulators.
- `apps/web/src/features/apps`: store, navigation, deferred UI loading and
  workspace-scoped UI services.

An **app installation** belongs to one workspace. A connector app can create multiple
**connections**; UI-only apps need no connections or connector encryption keys. Apps share
a process and React runtime: there is no remote code download, iframe sandbox or
independent deployment. Keep server-only imports out of `src/web`.

Inside an app, `src/domain` holds pure rules and installation validation,
`src/application` use cases, `src/infrastructure` provider adapters and storage, `src/api`
HTTP routes and `src/web` UI. Each layer imports only inner layers of its own app:
application uses domain; infrastructure uses domain, application and the app's
`config.ts`; api uses domain and application; web uses domain only. Root files such as
`index.ts` compose the layers, and tests may also import them and `src/test-support`.
Apps never import another app's source. `pnpm lint` enforces import direction only; unlike
domain packages, it does not restrict which libraries an app's inner layers use.

## Install and uninstall

People with `apps.manage` install an app after reviewing the access it requests, and
uninstall it or approve access an upgrade requests. The installation is persisted before
its settings UI is downloaded. Connections stay pending until the app validates access.

Uninstall is one tenant-scoped transaction: it advances the installation version, deletes
connection credentials, clears connection grants and app scopes, removes the app's
permissions from every role, disconnects every connection and records lifecycle events.
Reinstalling restores neither scopes, role permissions nor credentials. Observations,
cases, mappings and audit data remain. Requests already in flight can finish, but no new
credential access or capability dispatch happens.

Each connection records its app ID, provider identity and installation version, and the
database rejects late credential writes from an older installation. Shopify OAuth state
also binds the installation version and is cleared on uninstall.

`installed` and `uninstalled` hooks run inside the host's transaction. Use the supplied
transaction for app-owned storage, never make provider requests there, and persist an
outbox event for external cleanup that needs retries.

App packages missing from a deployment are omitted from the catalog. Their historical
installations can still be listed and uninstalled, their capabilities are unavailable,
and core pages and historical records keep working.

## Permissions and scopes

Manifests are plain data validated at registration:

- `permissions`: the app's own permissions, keyed `<app-id>:<name>` with a label,
  description and `consequential` flag. Core keys, other namespaces and duplicates are
  rejected. Owner and Admin hold them automatically; custom roles are granted them in
  role settings.
- `scopes`: core permissions the app needs, such as `orders.read` or `actions.execute`.
  Installing grants exactly these, and only those the installer holds. Scopes a newer
  version adds stay pending until someone with `apps.manage` approves them.
- `slotAccess`: the permission required for each UI slot. The host mounts a slot only for
  people who hold it and passes `can(permission)`.
- `decisionAccess`: the permissions to see and to respond to each decision kind.
- `actionAccess`: the permission a person needs to request each provider write capability
  through the app, keyed by installation capability. Order change plans use it to say
  whether the reader may start a Luma step; the app's routes still check it.

When an app acts for a person, `requirePermission(context, { app, permission, scopes })`
requires the installation, the app permission, and each scope both granted to the app and
held by the person. Connector write capabilities declare `descriptor.permission` (for
example `jtl:purchase_orders.submit`); policy then requires that permission to propose,
approve or run them instead of `actions.propose` and `actions.execute`, and building a
write capability requires the app's `actions.execute` scope. Installations store the
manifest's permission definitions, so roles can show permissions of a missing app
package; those grant nothing. See [ADR-009](architecture/009-permissions-and-roles.md).

## App package contract

Every app package meets these requirements. The
[add-workspace-app](../.agents/skills/add-workspace-app/SKILL.md) skill covers the full
procedure, including the protocol client, simulator, pilot and tests.

1. Create `packages/apps/<app-id>` exporting `createApp(context): AppDefinition`. Use the
   same stable ID for the directory, manifest and connector contribution. Validate
   app-specific settings inside the app.
2. For connectors, implement `ConnectionProvider`. Its `build` receives a connection
   service that checks tenant ownership, installation, status and grants on every
   credential request. Keep normalized capabilities and execution authorization in core.
3. For UI, export a default component from `src/web/index.tsx` accepting `AppUiProps` and
   declare the slots it implements in `manifest.ui` (see [UI slots](#ui-slots)).
4. To list decisions in [Needs you](needs-you.md), implement `decisions(context)` and
   declare `decisionAccess` per kind. The host calls it only for installed apps and filters
   by those permissions. Read persisted state only. Each decision has a stable app-prefixed
   ID, why a person is needed, what each response causes, the exact change and its
   deadline, and points to the app's `inventory` or `fulfillment` slot, whose controls take
   the response.
5. If the app stores the reads and receipts its provider writes cite, implement
   `evidence(tx, tenantId, ids)` so the [evidence view](execution.md#reading-cited-evidence)
   resolves them. It reads only the cited IDs inside the caller's read-only transaction and
   returns each read's source record, times, revision, completeness and adapter version, and
   each receipt's records, adapter version and dispatch identity. Fields the app never
   recorded are null. Return no payloads, credentials or personal data, and make no
   provider requests.
6. Register workspace HTTP operations below
   `/v1/organizations/:organizationId/apps/<app-id>/...` with `config.access` (a
   permission or `{ access: 'member' }`). The host applies membership and Origin checks
   and checks installation and the declared permission before the handler runs; a tenant
   route without a declaration fails at startup. Services still call `requirePermission`
   for the full check. Signed callbacks and webhooks declare
   `config.authentication: 'app'` and must validate their own signature and session.
7. Put app migrations in `packages/apps/<app-id>/migrations/*.sql`. They run after core
   migrations, in directory and filename order, recorded as `app:<app-id>/<filename>`, and
   database integration suites apply them the same way. Use tenant RLS and grant only the
   runtime access needed. Provider migrations already in the core sequence stay there.
8. Run `pnpm apps:sync` and `pnpm install`; the catalog generator updates composition
   dependencies from the packages on disk.

## UI slots

The catalog holds metadata only. App UI is discovered with deferred imports and mounts
only after the workspace API confirms both the installation and the slot, so an
uninstalled app's module is never downloaded and each provider builds into its own chunk.
A loading state and error boundary isolate failures; switching workspaces remounts
contributed UI.

The host-owned app management page lists the app's connections, granted access, setup
and uninstall. Members can view connections; `connections.manage` manages them.

- `connections`: setup for a new connection.
- `settings`: settings for the supplied `connection`.
- `app-settings`: optional workspace-wide settings, without a `connection`. Connector apps
  get the standard management page without it.
- `page`: the app's own workspace page, listed in navigation.
- `record`: live source context for a record the host shows. The host passes `kind`,
  `connectionId` and source `externalId`, only for a connection owned by the app. Read
  through the app's own authorized operations and do not retain the details. An optional
  `change` asks the app to prefill a planned change by source line ID; the app reviews it
  through its own preview and approval and ignores lines it doesn't recognize.
- `inventory`: governed corrections for the supplied canonical `inventory.positionId`.
  The app resolves exact source identity, authority and grants on the server; the host
  never supplies a writable quantity.
- `fulfillment`: governed actions for one source fulfillment, passed only for open
  fulfillment orders of a connection owned by the app. The app checks eligibility,
  approval and verification on the server.

## Remove an app from a deployment

Delete `packages/apps/<app-id>`, run `pnpm apps:sync` and reinstall dependencies before
building; no core source changes are needed. Leave applied migrations and historical data
intact. Provider-specific integration suites declare their required apps in
`packages/application-runtime/app-test-suites.json`, and `apps:sync` updates
`tsconfig.apps.json` so suites requiring removed apps are not collected. Protocol clients
and simulator packages can remain for fixtures or be removed with their tooling.

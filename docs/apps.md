# Workspace apps

Apps are first-party packages in `packages/apps/<app-id>`. An app owns its provider settings, validation, adapters, OAuth, webhooks, configuration, and UI. Protocol clients remain in `packages/connectors/*`; core connections never import a provider implementation.

## Ownership

- `@luma/app-host`: registration, workspace installation lifecycle, tenant authorization, lifecycle events, and UI contribution contracts.
- `@luma/app-catalog`: deployment composition. `src/generated.ts` is the only production list of app package imports.
- `@luma/connections`: encrypted credential storage, connection lifecycle, normalized capabilities, observations, and execution bridges. Provider behavior is injected through `ConnectionProvider`.
- `@luma/app-shopify` and `@luma/app-jtl`: provider integration and setup UI. They use shared host services and public package exports.
- `apps/web/src/features/apps`: store, navigation, deferred UI loader, and workspace-scoped UI services.

An **app installation** belongs to one workspace. A connector app can create multiple **connections**. UI-only apps need no connections or connector encryption keys.

## Install and uninstall

Owners and admins install an app from Apps & connections. Installation is persisted before its settings module is downloaded. Connections remain pending until their app validates access; Shopify uses OAuth authorization.

Uninstall is an atomic tenant-scoped transaction. It advances the installation version, deletes connection credentials, clears grants, disconnects every app connection, and records lifecycle events. Historical observations, cases, mappings, and audit data remain. In-flight provider requests can finish; uninstall prevents new credential access and capability dispatch. Reinstall never restores deleted credentials.

Each connection records its app ID, provider identity, and app installation version. Database checks reject late credential writes from an older installation. Shopify OAuth attempts also include the installation version in their stored binding. Uninstall clears pending Shopify authorization state.

`installed` and `uninstalled` hooks run inside the host's database transaction. Use the supplied transaction for app-owned storage changes. Do not make provider requests there. Persist an outbox event for external cleanup that needs retries.

App packages missing from a deployment are omitted from the catalog. Their historical installation records can still be listed and uninstalled. Unknown capabilities are unavailable; core pages and historical records continue working.

## Add an app

1. Create a workspace package at `packages/apps/<app-id>` with a public `createApp(context): AppDefinition` export. Use the same stable ID for the directory, manifest, and connector contribution.
2. Return metadata and optional connector, lifecycle, HTTP, and readiness contributions. Validate app-specific settings inside the app. Never branch on provider IDs in core.
3. For connectors, implement `ConnectionProvider`. Its `build` method receives a connection service that checks current tenant ownership, app installation, status, and grants on every credential request. Keep normalized capabilities and execution authorization in core.
4. For UI, export a default component from `src/web/index.tsx` accepting `AppUiProps`. Declare supported slots in `manifest.ui`: `connections`, `settings`, `app-settings`, `page`, `record`, `customers`, `inventory`, or `fulfillment`. Page contributions appear in workspace navigation. The host supplies connection operations and authenticated requests within the app's workspace API namespace.
5. Register workspace HTTP operations below `/v1/organizations/:organizationId/apps/<app-id>/...`. Core membership and Origin checks apply. Each handler must call `context.requireInstalled` before doing app work. Signed callbacks and webhooks can declare `config.authentication: 'app'`; those handlers must validate their own signature and session as appropriate.
6. Put new app migrations in `packages/apps/<app-id>/migrations/*.sql`. The migration runner applies core migrations first, then app migrations in directory and filename order. Names are recorded as `app:<app-id>/<filename>`. Use tenant RLS and grant only required runtime access. Existing provider migrations remain in the immutable historical core migration sequence.
7. Run `pnpm apps:sync`, `pnpm install`, and the normal checks. The catalog generator updates composition dependencies from packages present on disk.

Apps share a process and React runtime because they are trusted first-party code. There is no remote code download, iframe sandbox, or independent deployment protocol. Use the common UI package and keep server-only imports out of `src/web`.

## Frontend loading

The catalog contains metadata only. `import.meta.glob` discovers app UI using deferred imports; it never uses eager loading. A component mounts only when the current workspace API confirms both the installation and declared slot. Navigating to an uninstalled app does not import its module. A loading state and error boundary isolate rendering failures. Switching workspaces remounts contributed UI.

The production build emits separate provider chunks. Shared UI dependencies can be shared chunks. Browser tests assert that no app modules are requested before installation and that configuring JTL does not download Shopify.

## Remove an app from a deployment

Remove its `packages/apps/<app-id>` directory, run `pnpm apps:sync`, and reinstall workspace dependencies before building. The generated catalog no longer imports it; the frontend glob no longer discovers it. No core source changes are needed. Leave applied database migrations and retained historical data intact. Protocol clients and simulator packages can remain for fixtures, or be removed along with their owning development tooling.

Provider-specific integration fixtures declare required apps in `packages/application-runtime/app-test-suites.json`. `apps:sync` updates `tsconfig.apps.json`, shared by TypeScript and Vitest, so suites requiring removed apps are not collected. Connector setup stories likewise run only when their app fixtures are present. Core runtime availability does not depend on those fixtures. `pnpm test:architecture` checks that core packages do not import app implementations. App-host tests cover an empty registry and UI-only apps; PostgreSQL tests cover revocation, tenant isolation, stale versions, missing packages, and delayed writes.

## App management UI

Apps & connections separates installed apps from the available catalog. Each installed
app links to `/app/:organizationId/apps/:appId/settings`, a host-owned management
page with its connections, setup action, and uninstall control. Members can view
connections; owners and admins can manage them. Historical connections remain
accessible after uninstall or removal of an app package. Existing connection hash
links on the overview forward to the matching app management page.

UI slots have distinct responsibilities:

- `connections`: setup for a new connection, opened by **Add connection**.
- `settings`: settings for the supplied individual `connection`.
- `app-settings`: optional workspace-wide app settings, rendered on the management
  page for owners and admins without a `connection`.
- `page`: the app's own workspace page, separate from management.
- `record`: live source context for a record the host is showing. The host passes
  `record` (`kind`, `connectionId` and the record's source `externalId`) and mounts
  the slot only for a source connection owned by the app. The Orders workspace uses
  it for each order source. Read through the app's own authorized operations; do not
  retain the returned details.

- `customers`: app-owned live customer search and source context for the Customers workspace.
- `inventory`: app-owned governed corrections for the supplied canonical
  `inventory.positionId`. The app must resolve exact source identity, authority and
  grants on the server; the host does not supply a writable quantity.
- `fulfillment`: app-owned governed actions for one source fulfillment. The host
  passes `fulfillment` (`connectionId`, source `orderId` and source `fulfillmentId`)
  only for open fulfillment orders of a connection owned by the app. The app checks
  eligibility, approval and verification on the server.

Declare only the slots the app implements. Connector apps do not need to contribute
`app-settings` to receive the standard connection management page. Apps without
connections can contribute `app-settings` without displaying a connection section.

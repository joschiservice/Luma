---
name: add-workspace-app
description: Add a workspace app or provider connector to Luma, end to end - protocol client, app package, capabilities, setup UI, migrations, simulator provider, pilot wiring, tests and guides. Use when integrating a new provider (such as a shop, ERP, shipping or mail system) or a new UI-only workspace app.
---

# Adding a workspace app

A workspace app is a trusted first-party package that a workspace installs. A connector app
adds provider capabilities through connections; a UI-only app adds workspace UI without
connections. Core never imports a provider implementation or branches on provider IDs, so
everything provider-specific lands in the packages below. Starshipit is a compact working
example of a connector app; Shopify is the most complete one.

Read these first; they hold the rules this procedure relies on:

- [Workspace apps](../../../docs/apps.md): ownership, install and uninstall, permissions and
  scopes, and the [app package contract](../../../docs/apps.md#app-package-contract).
- [Connector capabilities](../../../docs/connectors.md): the capability contract,
  [adapter requirements](../../../docs/connectors.md#implement-an-adapter), writes and
  verification, errors and evidence.
- [Installed connections](../../../docs/installed-connections.md): credentials, connection
  state and permission-gated composition.

## 1. Protocol client

For a new provider, add `packages/connectors/<provider>` following
[the connector packages](../../../packages/connectors/README.md): transport, provider
schemas and signature checks, with credentials and transport passed in explicitly. It never
reads environment variables and holds no tenant data. Raise provider failures as
`ConnectorError` from `@luma/connector-core`. Exports point to `dist`, so build the package
(or run its `dev` watch) before consumers see changes.

## 2. App package

Create `packages/apps/<app-id>` with the same stable ID for the directory, manifest and
connector contribution, and meet each point of the
[app package contract](../../../docs/apps.md#app-package-contract): `createApp`,
`ConnectionProvider`, UI slots, Needs you decisions, workspace HTTP operations and app
migrations. Keep the usual layers: rules in `src/domain`, provider access and mapping in
`src/infrastructure`, UI in `src/web` with no server-only imports.

- Advertise only capabilities the adapter implements with the declared semantics. A write
  returns an acceptance receipt; add a verifier that confirms the outcome with a fresh,
  independent read.
- Write capabilities declare `descriptor.permission` and go through policy, approval and
  Action Admission like every other write.
- App migrations follow the [add-migration](../add-migration/SKILL.md) skill, in the app's
  own `migrations` directory.
- User-facing text goes in an app namespace in `@luma/i18n`; see the
  [localize-ui](../localize-ui/SKILL.md) skill.

Run `pnpm apps:sync` and `pnpm install`. The generator updates the catalog in
`@luma/app-catalog` and the composition dependencies from the packages on disk; don't edit
the generated module by hand.

## 3. Simulator and pilot

Every installed connector adapter needs synthetic provider behavior so development and
journeys exercise the real adapter:

- Add `packages/simulator/<provider>` for the provider protocol, depending only on
  `@luma/simulator-core`. Serve the same request shapes Luma sends, so unknown fields or
  operations fail like the real API.
- Compose it in the simulator host (`apps/simulator`): the merchant world, dispatch and
  session wiring. Merchant behavior belongs in the engine, not the provider package.
- Provision a connection for it in the pilot (`tooling/pilot`), with the read and write
  capabilities the provider supports, bound in the simulator manifest.

See the [commerce simulator](../../../docs/simulator.md) guide. Simulator compatibility does
not prove live-provider compatibility.

## 4. Tests

- Colocate adapter, mapping and verifier tests in the app package, with provider fixtures.
  Cover invalid provider payloads, partial pages, provider errors and uncertain writes.
- Add backend journeys (`apps/api/e2e/<app-id>*.e2e.mjs`) for setup, sync and governed
  writes, and a browser journey for the setup UI. Cover tenant isolation, missing
  permissions and uninstall.
- Map the new journeys and the app, connector and simulator packages in
  `apps/api/e2e/journey-areas.mjs`. Add the packages and journeys to the relevant
  selections in `tooling/dev/verify-feature.mjs` and `tooling/dev/test-plan.mjs`.

## 5. Guides and help

- Add `docs/<provider>.md` covering provider semantics, authority limits and failure
  behavior, list it in the [docs index](../../../docs/README.md), and link it from the app's
  `README.md`.
- Describe setup for users in the product guides in `apps/web/content/docs`, in English and
  German.

Finish with the [verify-change](../verify-change/SKILL.md) skill.

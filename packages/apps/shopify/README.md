# @luma/app-shopify

First-party Shopify workspace app. Owns provider settings, permission verification, normalized adapters, configuration and deferred setup UI.

The public `createApp` factory contributes to the app host. Low-level provider protocols stay in `@luma/connector-shopify`. Use public exports for adapter fixtures. Refresh the pinned provider schema with `node apps/api/scripts/update-shopify-schema.mjs 2026-07`, and copy it to `@luma/simulator-shopify`, whose schema must stay identical.

See [Workspace apps](../../../docs/apps.md) for installation lifecycle, UI slots, migration ownership and removing an app.

## Operational records

The Shopify workspace page and the connection settings record browser show live, allowlisted Shopify records: orders and products, followed through customers, variants, inventory items, fulfillment orders, returns and refunds. Every provider request uses the current tenant, app installation version and installed capability. Results carry source IDs, source timestamps, observation time and API version. These reads are not canonical projections or synthetic activity events.

The `record` UI slot shows the same live read for one order inside the Orders workspace. The host passes the order's Shopify GID; the slot shows nothing it could not read with the connection's current scopes.

Coverage rules:

- Each section reports available data, missing scopes, required protected-data approval, Shopify access denial or partial coverage.
- Nested connections are fully paginated. Failed or cyclic pagination never produces an empty successful section.
- Fulfillment coverage is limited to the granted fulfillment categories. Order history covers 60 days unless `read_all_orders` is approved and granted.
- Returned amounts keep their decimal representation and currency.
- Source timeline entries come from Shopify's paginated events, not webhook arrival or snapshot read times.

Scopes and approvals:

- `read_returns` and `read_locations` are requested but optional for basic connection health. With `read_returns`, the connection grants `returns.read`, which imports returns and refunds into the [Returns workspace](../../../docs/returns-workspace.md). Connections authorized without it must reconnect.
- Set `SHOPIFY_PROTECTED_CUSTOMER_DATA_APPROVED=true` only after Shopify approves protected customer data for the deployed app, then reconnect to request `read_customers`. Set `SHOPIFY_CUSTOMER_CONTACT_APPROVED=true` only after Shopify approves name, email and phone access. The flags are operator attestations, not proof of approval; provider denials stay visible and withhold the affected section. Addresses and free-text event messages are never requested. See [Customers workspace](../../../docs/customers-workspace.md).

Webhook refresh hints cover transactions, refunds, returns, customer updates, inventory items, locations and fulfillment holds, with signed-body verification and tenant and connection deduplication. Deployment webhook registration and delivery are separate from the refresh-hint mapper.

Provider references: [Order](https://shopify.dev/docs/api/admin-graphql/2026-07/objects/Order), [FulfillmentOrder](https://shopify.dev/docs/api/admin-graphql/2026-07/objects/FulfillmentOrder), [protected customer data](https://shopify.dev/docs/apps/launch/protected-customer-data).

## Governed actions

The app contributes two governed provider writes. Both require approval by a different person who can approve changes before Action Admission executes them, and both keep provider acceptance separate from independently observed results. See [Shopify actions](../../../docs/shopify-actions.md) for claims, retries, scope requirements and verification.

- **Fulfillment recovery:** people with `shopify:fulfillment_recovery.run` preview an exact hold release, reopening or move of a fulfillment order.
- **Inventory corrections:** the Inventory stock detail reviews ERP-to-Shopify available stock. Each exact item and location correction requires a fresh ERP observation, confirmed mappings and inventory write access. Shopify compare-and-set and provider idempotency protect dispatch; a separate read verifies the approved quantity.

# @luma/app-shopify

First-party Shopify workspace app. Owns provider settings, permission verification, normalized adapters, configuration, and deferred setup UI.

The public `createApp` factory contributes to the app host. Low-level provider protocols remain in `@luma/connector-shopify`. Use public exports for adapter fixtures.

See [Workspace apps](../../../docs/apps.md) for installation lifecycle, UI slots, migration ownership, and removing an app.

## Operational records

The Shopify workspace page browses orders and products and follows source links
through customers, variants, inventory items, fulfillment orders, returns and
refunds. Connection settings also include the record browser. Reads use the
current tenant, app installation version and installed capability on every
provider request. The app-owned `records` operation returns allowlisted live
records with source IDs, source timestamps, observation time and API version.
These reads are not canonical projections or synthetic activity events.

Each section reports available data, missing scopes, required protected-data
approval, Shopify access denial or partial coverage. Nested connections are
fully paginated; failed or cyclic pagination never produces an empty successful
section. Fulfillment coverage is limited to the granted fulfillment categories.
Order history normally covers 60 days unless `read_all_orders` is approved and
granted. Returned amounts retain their decimal representation and currency.

OAuth requests `read_returns` and `read_locations` in addition to the existing
required scopes. These additional scopes are optional for basic connection
health. Set `SHOPIFY_PROTECTED_CUSTOMER_DATA_APPROVED=true` only after approval
for the deployed app in Shopify, then reconnect to request `read_customers`.
The flag is an operator attestation, not proof of Shopify approval; provider
denials remain visible. Customer context reads identity, update time, order
count, spend and linked orders. Set `SHOPIFY_CUSTOMER_CONTACT_APPROVED=true`
only after Shopify approves name, email and phone access. These fields are read
live in the Customers workspace; provider denial withholds the contact section.
Addresses and free-text event messages are not requested. See
[Customers workspace](../../../docs/customers-workspace.md).

Webhook refresh hints now include transactions, refunds, returns, customer
updates, inventory items, locations and fulfillment holds. They retain the
existing signed-body verification and tenant/connection deduplication. Source
timeline entries come from Shopify's paginated events, not webhook arrival or
snapshot read times. Deployment webhook registration and delivery infrastructure
remain separate from the refresh-hint mapper.

The `record` UI slot shows the same live read for one order inside the Orders
workspace: totals, transactions, customer (when approved), fulfillment orders and
holds, returns, refunds and source events, with a link to the order in Shopify
admin. Linked records open in place. The host passes the order's Shopify GID; the
slot shows nothing it could not read with the connection's current scopes.

Validate with `pnpm --filter @luma/app-shopify test` and the
`Apps/Shopify records` stories. Refresh the pinned provider schema with
`node apps/api/scripts/update-shopify-schema.mjs 2026-07`.

Provider references: [Order](https://shopify.dev/docs/api/admin-graphql/2026-07/objects/Order),
[FulfillmentOrder](https://shopify.dev/docs/api/admin-graphql/2026-07/objects/FulfillmentOrder),
[protected customer data](https://shopify.dev/docs/apps/launch/protected-customer-data).

## Fulfillment recovery

Owners and admins can preview an exact hold release, reopening or move from a
fulfillment order. Another administrator approves it before Action Admission
executes it. Mutation acceptance and independently observed fulfillment progress
remain distinct. See [Shopify fulfillment recovery](../../../docs/shopify-fulfillment-recovery.md)
for claims, retries, scope requirements and validation.

## Inventory corrections

The Inventory stock detail hosts Shopify's governed ERP-to-Shopify available-stock
review. Each exact item/location correction requires a fresh ERP observation,
confirmed mappings, inventory write access and a different administrator's
approval. Shopify CAS and provider idempotency protect dispatch; a separate read
verifies the approved quantity. See [Shopify inventory corrections](../../../docs/shopify-inventory-corrections.md).

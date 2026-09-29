# Shopify read adapter

`createShopifyConnector` from the connectors composition entry implements `orders.read`, `products.read`, `inventory.read` and `fulfillment.read` using the official `@shopify/admin-api-client` and Shopify Admin GraphQL API `2026-07`. Workflows use the existing `CapabilityReader`; provider queries and normalization stay inside connectors.

## Connection and authentication

Compose one adapter per trusted tenant/connection/shop binding. Supply the lowercase `*.myshopify.com` hostname, an `accessToken()` function backed by tenant-scoped secret storage, and an awaited `recordObservations()` persistence function. The token is resolved for every request to support rotation. Requests use HTTPS, reject redirects and time out after 15 seconds by default. `timeoutMs` accepts 1–120,000 milliseconds. Tokens never appear in descriptors, observations or normalized failures.

The runtime resolver must check current tenant ownership and connection state on each invocation. Return the adapter only for an active connection. Installation, OAuth token acquisition, connection storage and HTTP webhook registration belong to the host composition; this adapter does not register a shop globally or introduce environment credentials.

Required grants:

- `read_orders`; Shopify normally limits order access to the last 60 days. Request approved `read_all_orders` access when historical reconciliation needs older orders.
- `read_products` and `read_inventory` for variants, inventory items and stock levels.
- The applicable fulfillment-order read scopes: `read_merchant_managed_fulfillment_orders`, `read_assigned_fulfillment_orders` and/or `read_third_party_fulfillment_orders`. Visibility depends on the installation's granted scopes. Provision all scopes required for the locations being reconciled.

No write capabilities are advertised. A missing grant returns `permission_denied`; it never becomes an empty successful page. Scope-restricted collections cannot establish shop-wide deletion.

## Read and mapping semantics

`limit` accepts 1–100 and bounds the number of parent orders, products or inventory items scanned. A parent can produce multiple observations. Cursors bind the tenant, connection, shop, API version, capability, page size and filters. Preserve them unchanged and use the same query when requesting the next page.

Nested order lines, product variants, inventory locations, fulfillment orders and fulfillment lines are fully paginated before returning a page. Missing/repeated cursors, malformed fields, GraphQL partial errors or failed child requests reject the whole page. A safety ceiling of 1,000 continuation pages per nested collection rejects oversized scans instead of returning truncated data. Reads across requests are observations, not a transactional Shopify snapshot. Only a successful full scan within the granted visibility supports absence checks; no read emits inferred tombstones.

| Resource         | Mapping                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Order            | Shopify GID, display number, creation time as `placedAt`, current total in shop currency, cancellation/closed state, financial summary and original ordered quantities with line title and SKU text. Unknown financial statuses remain `unknown`. `cancelledQuantity` is null because refunds/removals do not establish cancelled units. Deleted/custom variants have null SKU identity. Malformed descriptive fields become null without rejecting the order. |
| Product          | Product GID, title, active/archived status and inventory-item SKU identities. Draft or unrecognized status is `unknown`. SKU text preserves case and is never used as identity.                                                                                                                                                                                                                                                                                |
| Inventory        | InventoryItem GID plus Location GID. `on_hand` → onHand, `committed` → reserved, `available` → available, in `each`. Missing/untracked values stay null; zero and negative stock are preserved. Availability is provider-reported only when available is known.                                                                                                                                                                                                |
| Fulfillment work | Each FulfillmentOrder is a separate operation. Line quantities represent remaining work. Open/scheduled/on-hold → pending; in-progress → processing; cancelled → cancelled; incomplete → failed. Closed is `unknown`, not shipment evidence.                                                                                                                                                                                                                   |
| Shipment         | Each Fulfillment is separate from outstanding work. Successful shipment → shipped, or delivered when delivery time is present; open/pending/cancelled/error/failure retain their corresponding lifecycle. Actual fulfillment-line quantities support split shipments.                                                                                                                                                                                          |

Order-line identities include the parent Order GID as `scopeKey`. Inventory observation identities use the InventoryItem GID with Location GID as scope; their SKU and location references remain account-wide. All observations carry tenant/connection identity, source update time, observation time and adapter/schema versions. Source revisions are null because these reads do not expose a conditional revision token. Shopify `updatedAt` supplies the best available progress timestamp for outstanding fulfillment work; unrelated provider edits may also change it.

Inventory filters accept InventoryItem and Location GIDs with empty scope. Fulfillment filtering accepts an Order GID. Filters do not accept SKU labels or raw Shopify search expressions.

## Evidence and events

`recordObservations` must durably save the validated batch before resolving. A persistence failure prevents a successful read result. Supply the observation-ID generator from ingestion when retrying an existing ingestion batch; the default generates new UUIDs for new polls. The ingestion layer owns stable run/page/item keys, deduplication and canonical projection through module interfaces.

Raw capture is off by default. Set a positive `rawRetentionMs` to pass allowlisted provider fields and an explicit expiry alongside the observations. Unknown fields, customer/address payloads, credentials, headers and error messages are excluded. The storage implementation must encrypt retained bytes, enforce tenant access, link them to observations and purge them on expiry. No raw bytes are persisted by the transport itself.

`mapShopifyWebhook` verifies HMAC-SHA256 over the original request bytes and checks the expected shop. Pass the app client secret, `X-Shopify-Hmac-Sha256`, `X-Shopify-Shop-Domain`, `X-Shopify-Topic` and `X-Shopify-Event-Id` from the verified installation boundary. Its tenant/connection/topic/event key supports durable deduplication. It returns capability refresh hints for order, product, inventory and fulfillment events; unsupported topics return null. It never projects partial webhook fields or treats missing fields as deletion. Persist and enqueue the refresh hint before acknowledging delivery; run periodic scans to recover missed events.

## Errors and verification

HTTP authentication/permission/not-found errors, rate limits, server failures, network failures, timeouts and malformed responses map to the SDK error codes. HTTP `Retry-After` and GraphQL throttle cost produce delay advice. SDK retries are explicitly disabled; the adapter performs no automatic retries and returns `effect: none` for reads. GraphQL errors reject partial data, and an unexpected `X-Shopify-API-Version` rejects silent version fallback. Unclassified token-store failures return `transient` with delay advice; explicitly classified connector errors are preserved. Empty credentials return `authentication`. Raw provider error text is discarded.

`infrastructure/shopify/fixtures/commerce.json` is a synthetic deterministic fixture for a split order, an unmapped variant and stock across two locations. Adapter tests exercise the public capability runtime, pagination, isolation, filters, unknown values, evidence capture failures, transport errors and webhook signatures. They require no Shopify account. A live shop smoke test still requires an installation with the scopes above.

Query contract tests validate every emitted operation against `fixtures/admin-2026-07.graphql`, an offline snapshot extracted from Shopify’s versioned public schema. The snapshot retains the adapter’s fields, their complete argument definitions and referenced types. Negative cases reject unknown fields, unknown arguments and incompatible variable types. A separate version assertion requires a fixture refresh when `API_VERSION` changes.

Regenerate the snapshot from the repository root, then review the schema diff and rerun the tests:

```sh
pnpm --filter @luma/api exec node scripts/update-shopify-schema.mjs 2026-07
pnpm exec prettier --write packages/apps/shopify/src/infrastructure/fixtures/admin-2026-07.graphql
```

References: [orders and historical access](https://shopify.dev/docs/api/admin-graphql/latest/queries/orders), [inventory items](https://shopify.dev/docs/api/admin-graphql/latest/objects/InventoryItem), [fulfillment orders](https://shopify.dev/docs/api/admin-graphql/latest/objects/FulfillmentOrder), [order shipments](https://shopify.dev/docs/api/admin-graphql/latest/objects/Order#field-Order.fields.fulfillments), [webhook verification](https://shopify.dev/docs/apps/build/webhooks/verify-deliveries), [API limits](https://shopify.dev/docs/api/usage/limits).

## Connect Shopify

Owners and admins choose **Connect Shopify**, name the connection, and enter the
store's permanent `*.myshopify.com` hostname. Shopify asks them to approve read
access. On return, Luma verifies access and enables the connection. No merchant
app creation or token entry is required. **Reconnect Shopify** reauthorizes the
same connection, including disconnected or revoked installations.

The app requests `read_orders`, `read_products`, `read_inventory`,
`read_merchant_managed_fulfillment_orders` and
`read_third_party_fulfillment_orders`, plus optional `read_returns` and
`read_locations`. Approved deployments also request `read_customers`. It does not request write scopes or
`read_assigned_fulfillment_orders`: Luma is not a fulfillment service. Historical
orders beyond 60 days require separately approved `read_all_orders`; add this
only when historical reconciliation is approved and supported.

### Development app and store

1. Create a Luma development app and development store in Shopify's Dev Dashboard.
   Use synthetic orders, products, inventory and fulfillment data. Coordinate
   shared pilot fixtures with LUMA-31; do not use production customer data.
2. Configure the app as non-embedded. Enable the legacy installation flow
   (`use_legacy_install_flow = true`) for the standalone authorization-code grant.
   Set the scopes above and webhook API version `2026-07`.
3. Run `mise run setup`, then expose this checkout's printed **web** port through
   a public HTTPS tunnel. The web server proxies `/api` to the local API. For
   Tailscale, use `tailscale funnel --bg http://127.0.0.1:<web-port>` after granting
   Funnel to your account. Use a neutral device hostname if certificate
   transparency records should not contain your personal machine name.
4. Put the following in `apps/api/.env`, which is ignored by Git:

   ```dotenv
   SHOPIFY_CLIENT_ID=<development app client ID>
   SHOPIFY_CLIENT_SECRET=<development app client secret>
   SHOPIFY_APP_ENVIRONMENT=development
   SHOPIFY_CALLBACK_URL=https://<public-host>/api/v1/shopify/callback
   SHOPIFY_WEB_ORIGIN=https://<public-host>
   ```

5. Set Shopify's app URL to the web origin and allow the **exact** callback URL.
   Publish the app configuration version. Restart `mise run dev`; the managed
   development environment uses `SHOPIFY_WEB_ORIGIN` for auth and allows that
   host through Vite. Sign in through the public HTTPS origin before connecting.
   Manually managed environments must also set `BETTER_AUTH_URL` and
   `AUTH_TRUSTED_ORIGINS` to that origin, and permit its hostname in Vite.
6. Open Connections, connect the development store, approve access, and confirm
   **Validated**. Luma registers an installation-specific `app/uninstalled`
   subscription before activation. Keep the tunnel running for webhook delivery.
7. After testing, stop public exposure with `tailscale funnel --https=443 off`.

The managed setup provides connection encryption keys. Other environments must
configure `CONNECTIONS_ACTIVE_KEY_ID` and `CONNECTIONS_KEYS` and apply migration
`0006_shopify_oauth.sql`. Never put app secrets in `VITE_*` variables.

### Optional live pilot and public production app

Use a separate custom-distribution app only for an eligible live merchant pilot.
Custom distribution has merchant restrictions and cannot be converted to public
distribution. The merchant later installs the public app and reconnects. Use a
separate database/environment for the pilot; do not share credentials with the
local development app.

Production uses **one Luma-owned public app** for unrelated merchants. Each shop
has its own installation and offline token pair. Set all five Shopify settings
to production values, use a stable public HTTPS origin, and keep app credentials
in the deployment secret manager. Code is shared; credentials, redirects,
encryption keys and installations are separate per environment.

Before public launch:

- Complete Shopify public-app review and distribution approval.
- Obtain protected customer data access required for order reads. Request only
  the data needed by Luma; the adapter excludes customer and address fields.
- Register `customers/data_request`, `customers/redact`, and `shop/redact` at
  `/api/v1/shopify/privacy`. Assign and rehearse the privacy-queue operator
  workflow before production onboarding. The uninstall endpoint does not
  replace compliance handling.
- Verify production scopes, callback allowlists, uninstall delivery, encrypted
  backups, key rotation and recovery with the approved app.

### Authorization and recovery guarantees

The start route requires a current owner/admin and trusted request origin. State
is random, stored as a hash, expires after ten minutes, and is consumed once. It
binds the current login session, operator, tenant, shop and app environment.
Callbacks require Shopify's HMAC over the complete decoded, sorted query;
duplicate parameters and mismatches are rejected. Credentials never enter the
browser response, query cache or request logs.

Tokens use `expiring=1`. Access tokens, refresh tokens, provider expiry metadata,
app binding and granted scopes share the existing tenant-bound AES-GCM envelope.
PostgreSQL advisory and installation-row locks serialize authorization and
refresh across processes. Both rotated credentials and their lifecycle event
commit together. A token is refreshed within 60 seconds of expiry on the next
read, including workflow reads with no browser session. Temporary failures keep
the stored pair for retry; rejected or expired refresh credentials revoke the
connection and require reconnect. An uncertain authorization exchange can require
reconnect because a remote token issue and local database commit cannot be one
transaction.

One app/shop pair is reserved to one workspace. Reconnect reuses its connection
ID; another tenant cannot claim it. Existing duplicate manual installations must
be resolved before migration. Manual token setup remains available to internal
fixtures and deployments without OAuth configured; the normal UI uses OAuth.

A signed uninstall request checks the stored shop/app binding and current token
before revoking, so delayed deliveries cannot disable a newer working install.
Expired tokens are refreshed before that check. Revocation deletes the encrypted
secret and disables capabilities. Failed verification is retried by Shopify;
requests already sent may finish. Provider authentication and permission errors
also update connection health, without storing raw provider errors.

### Validation record

Automated coverage includes PostgreSQL RLS, callback HMAC and replay, operator and
session binding, app isolation, cancellation, missing scopes, concurrent refresh,
rotated credentials, transient failures, revocation, uninstall and reconnect.
Browser coverage checks Connect Shopify without credential fields and callback
recovery messages.

Live smoke test, 2026-09-18: Shopify development store
`luma-dev-store-1dmrgwsn.myshopify.com`, development app version `luma-2`, API
`2026-07`. Safari completed Connect Shopify and reconnect through a public HTTPS
callback. The connection became active with all four read capabilities and kept
its ID on reconnect. Both token expiries and all five scopes were present in the
encrypted credential envelope. An installation-specific uninstall subscription
was registered. After signing out a separate test login, the installed runtime
resolved workflow identity and successfully read two products and two inventory
observations; orders and fulfillment returned valid empty pages. Expiry/rotation,
uninstall and replay were exercised with automated fixtures; the live test did
not wait for the one-hour token expiry or uninstall the development app.

The first live attempt exposed an incorrect GraphQL scalar in uninstall webhook
registration. The mutation now uses `String!`, and OAuth integration tests validate
emitted operations against the versioned Shopify schema snapshot.

References: [standalone authentication](https://shopify.dev/docs/apps/build/authentication-authorization/authenticate-standalone-apps),
[access tokens and rotation](https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens),
[app distribution](https://shopify.dev/docs/apps/launch/distribution),
[protected customer data](https://shopify.dev/docs/apps/launch/protected-customer-data),
[privacy webhooks](https://shopify.dev/docs/apps/build/privacy-law-compliance).

## Operational record pages

Open **Shopify** in the workspace sidebar to select a store, browse orders or
products, and follow linked records. See the [operational records guide](../packages/apps/shopify/README.md#operational-records) for coverage, protected-data approval and validation.

Production configuration, approval requests, privacy operations and smoke-test
evidence are documented in [Shopify partner readiness](shopify-production.md).

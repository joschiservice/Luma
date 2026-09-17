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

| Resource         | Mapping                                                                                                                                                                                                                                                                                        |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Order            | Shopify GID, display number, cancellation/closed state, financial summary and original ordered quantities. Unknown financial statuses remain `unknown`. `cancelledQuantity` is null because refunds/removals do not establish cancelled units. Deleted/custom variants have null SKU identity. |
| Product          | Product GID, title, active/archived status and inventory-item SKU identities. Draft or unrecognized status is `unknown`. SKU text preserves case and is never used as identity.                                                                                                                |
| Inventory        | InventoryItem GID plus Location GID. `on_hand` → onHand, `committed` → reserved, `available` → available, in `each`. Missing/untracked values stay null; zero and negative stock are preserved. Availability is provider-reported only when available is known.                                |
| Fulfillment work | Each FulfillmentOrder is a separate operation. Line quantities represent remaining work. Open/scheduled/on-hold → pending; in-progress → processing; cancelled → cancelled; incomplete → failed. Closed is `unknown`, not shipment evidence.                                                   |
| Shipment         | Each Fulfillment is separate from outstanding work. Successful shipment → shipped, or delivered when delivery time is present; open/pending/cancelled/error/failure retain their corresponding lifecycle. Actual fulfillment-line quantities support split shipments.                          |

Order-line identities include the parent Order GID as `scopeKey`. Inventory observation identities use the InventoryItem GID with Location GID as scope; their SKU and location references remain account-wide. All observations carry tenant/connection identity, source update time, observation time and adapter/schema versions. Source revisions are null because these reads do not expose a conditional revision token. Shopify `updatedAt` supplies the best available progress timestamp for outstanding fulfillment work; unrelated provider edits may also change it.

Inventory filters accept InventoryItem and Location GIDs with empty scope. Fulfillment filtering accepts an Order GID. Filters do not accept SKU labels or raw Shopify search expressions.

## Evidence and events

`recordObservations` must durably save the validated batch before resolving. A persistence failure prevents a successful read result. Supply the observation-ID generator from ingestion when retrying an existing ingestion batch; the default generates new UUIDs for new polls. The ingestion layer owns stable run/page/item keys, deduplication and canonical projection through module interfaces.

Raw capture is off by default. Set a positive `rawRetentionMs` to pass allowlisted provider fields and an explicit expiry alongside the observations. Unknown fields, customer/address payloads, credentials, headers and error messages are excluded. The storage implementation must encrypt retained bytes, enforce tenant access, link them to observations and purge them on expiry. No raw bytes are persisted by the transport itself.

`mapShopifyWebhook` verifies HMAC-SHA256 over the original request bytes and checks the expected shop. Pass the app client secret, `X-Shopify-Hmac-Sha256`, `X-Shopify-Shop-Domain`, `X-Shopify-Topic` and `X-Shopify-Event-Id` from the verified installation boundary. Its tenant/connection/topic/event key supports durable deduplication. It returns capability refresh hints for order, product, inventory and fulfillment events; unsupported topics return null. It never projects partial webhook fields or treats missing fields as deletion. Persist and enqueue the refresh hint before acknowledging delivery; run periodic scans to recover missed events.

## Errors and verification

HTTP authentication/permission/not-found errors, rate limits, server failures, network failures, timeouts and malformed responses map to the SDK error codes. HTTP `Retry-After` and GraphQL throttle cost produce delay advice. SDK retries are explicitly disabled; the adapter performs no automatic retries and returns `effect: none` for reads. GraphQL errors reject partial data, and an unexpected `X-Shopify-API-Version` rejects silent version fallback. Raw provider error text is discarded.

`infrastructure/shopify/fixtures/commerce.json` is a synthetic deterministic fixture for a split order, an unmapped variant and stock across two locations. Adapter tests exercise the public capability runtime, pagination, isolation, filters, unknown values, evidence capture failures, transport errors and webhook signatures. They require no Shopify account. A live shop smoke test still requires an installation with the scopes above.

References: [orders and historical access](https://shopify.dev/docs/api/admin-graphql/latest/queries/orders), [inventory items](https://shopify.dev/docs/api/admin-graphql/latest/objects/InventoryItem), [fulfillment orders](https://shopify.dev/docs/api/admin-graphql/latest/objects/FulfillmentOrder), [order shipments](https://shopify.dev/docs/api/admin-graphql/latest/objects/Order#field-Order.fields.fulfillments), [webhook verification](https://shopify.dev/docs/apps/build/webhooks/verify-deliveries), [API limits](https://shopify.dev/docs/api/usage/limits).

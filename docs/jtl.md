# JTL-Wawi read adapter

`createJtlConnector` from the connectors composition entry implements `orders.read`, `products.read`, `inventory.read` and `fulfillment.read`. It targets the JTL ERP **2.2** response contract with shared normalization for on-premise and cloud connections. Workflows use `CapabilityReader`; no provider logic belongs in the consuming domain.

## Connection setup

Compose one adapter per trusted Luma tenant and connection. Supply an awaited `recordObservations` persistence hook. Resolve the adapter only after checking current connection ownership and active state on every invocation.

| Connection | Configuration                                                                   | Requests                                                                      |
| ---------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| On-premise | `kind: 'onprem'`, `baseUrl`, `appId`, `appVersion`, `challengeCode`, `apiKey()` | `Authorization: Wawi …`, registered app headers and `api-version: 2.2`        |
| Cloud      | `kind: 'cloud'`, `jtlTenantId`, `accessToken()`                                 | `https://api.jtl-cloud.com/erp/v2/`, `Authorization: Bearer …`, `X-Tenant-ID` |

On-premise `baseUrl` is the API database root, for example `http://127.0.0.1:5883/api/eazybusiness/`. Include the trailing slash; omit a version path. HTTPS is required except for loopback HTTP. Use a trusted HTTPS proxy or local agent for a remote installation. Reject URLs containing credentials, query parameters or fragments. Only trusted connection provisioning may set the destination; never accept it from a capability request.

Credentials resolve on every HTTP request, allowing rotation. The host owns app registration, OAuth token acquisition/refresh and encrypted tenant-scoped credential storage. Register read access for sales orders and their lines, items, warehouse stock, delivery notes and their lines. A licence or permission failure returns `permission_denied`, not an empty page. Confirm that the installation supports the 2.2 endpoints before activation; older API versions are not interchangeable.

Requests are GET-only, reject redirects and time out after 15 seconds. `timeoutMs` accepts 1–120,000 milliseconds. There are no global environment credentials or automatically registered connections.

## Mapping

| Capability          | Provider state                                                                  | Canonical behavior                                                                                                                                                                                                                                                                                                                                |
| ------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Orders              | Sales-order overview and complete line-item array                               | Cancelled, open or completed lifecycle from cancellation/delivery status; unknown enum values stay unknown. Fully paid → paid; unpaid → pending. Partial payment stays unknown because the canonical payment enum has no partial-payment state. Original quantities and units are retained; custom lines with item ID zero have no SKU reference. |
| Products            | Item overview                                                                   | Each JTL item is a product with its own item-ID SKU reference. SKU text preserves case and is never identity. Active/inactive → active/archived.                                                                                                                                                                                                  |
| Inventory           | Item overview stock totals                                                      | Account-wide on-hand, reserved and available quantities remain independent provider reports. The aggregate location ID is `all-warehouses`. Missing or untracked values remain null; zero, negative and fractional values are preserved.                                                                                                          |
| Warehouse inventory | Warehouse/item stock endpoint when a warehouse location filter is supplied      | Physical on-hand only. Reserved and available remain null: locked stock is not an order reservation, and warehouse disposable stock is not account-wide sale availability.                                                                                                                                                                        |
| Fulfillment         | Delivery-note detail, every delivery-note line page, matching sales-order lines | Each delivery note is a separate operation. All packages have shipping dates → shipped; otherwise processing. Line quantities preserve split fulfillment. Progress time is the latest known package shipping date, or note creation time.                                                                                                         |

Inventory comparisons require explicit mappings between equivalent stock pools. Do not compare `all-warehouses` to a single Shopify location without an aggregation mapping. Item modification time describes product edits, not inventory freshness; inventory source-update time remains null.

Order-line IDs include the order ID as their scope. Inventory observations use the item ID scoped to the location. All observations include tenant, connection, provider, observation time, adapter version and schema version. Source revision is null. Order and delivery-note creation dates are not update timestamps.

Unit labels `stk`, `Stück` and `each` map to `each`. Other nonempty labels are retained. Supply `units` for installation-specific canonical aliases; this does not convert quantities. Unknown unit mappings must block cross-provider comparisons. JSON decimal tokens are preserved before JavaScript numeric rounding; unsupported precision is rejected rather than rounded.

Delivery notes do not expose operations that have not yet produced a note, carrier delivery confirmation, or a reliable failure code. No absence, zero timestamp or tracking label is treated as shipment or deletion evidence. A partly shipped note remains processing because the API does not link individual packages to line quantities. Missing order-line links or duplicate links within one delivery note reject the page rather than omit or overwrite quantities.

## Pagination and evidence

`limit` is 1–100 parent records. Cursors bind the tenant, connection, API destination, JTL cloud tenant, capability, page size, filters and unit mapping. Preserve them unchanged. JTL pages start at 1; inconsistent page numbers, counts and continuation metadata reject the read. Delivery-note lines are fully paginated with duplicate detection and a 1,000-page ceiling. A child failure rejects the entire parent page.

SKU filtering scans item pages locally because the overview endpoint has no exact item-ID filter. Continue through empty filtered pages while a cursor remains. A fulfillment order filter uses the documented `salesOrderNumberId` parameter and checks the returned detail's order identity. Location filters other than `all-warehouses` are JTL warehouse IDs, not bin IDs. Resource IDs accept local positive integers or cloud UUIDs and preserve their identity; they are never converted between connection types.

A successful page is complete for the requested parent records. Offset pagination is not a transactional snapshot; concurrent source changes can shift records between pages. Only a successful full scan within the connection's visibility supports absence checks. No read emits inferred tombstones.

`recordObservations` must durably save the validated batch before resolving. Failure prevents success. Ingestion owns stable run/page/item deduplication keys and canonical projection. Inject `id()` when retrying an existing ingestion batch; the default generates fresh observation UUIDs.

Raw capture is off by default. Set `rawRetentionMs` to a positive integer, at most one year, to capture allowlisted parsed provider fields with an expiry. Addresses, customer details, free-text comments, credentials and HTTP error bodies are excluded. Storage must encrypt evidence, enforce tenant access, link it to observations and purge expired payloads.

HTTP authentication, permissions/licensing, missing resources, conflicts, rate limits, server failures, network failures, timeouts and malformed responses map to SDK errors with `effect: none`. Retry-After seconds or dates provide scheduler advice for 429/503 responses. The adapter never retries automatically. Credentials and provider error text are excluded from normalized failures.

## Verification

Synthetic fixtures cover both connection modes, split shipments, unmapped lines, negative/fractional inventory, warehouse reads, filtering, scoped cursors, precision, evidence failures and transport errors. Tests require no live JTL installation. A live smoke test remains necessary for each installation's version, permissions and network route.

`fixtures/erp-2.2.json` retains structural definitions for the consumed endpoints from JTL's published OpenAPI schema. Contract tests check the allowlisted response projections against those field names and types. Refresh it with:

```sh
node apps/api/scripts/update-jtl-schema.mjs
pnpm exec prettier --write apps/api/src/modules/connectors/infrastructure/jtl/fixtures/erp-2.2.json
```

References: [JTL ERP 2.2 OpenAPI](https://developer.jtl-software.com/openapi/erp/2.2.json), [authentication](https://developer.jtl-software.com/cloud/guides/essentials/authentication/oauth2-flow), [versioning](https://developer.jtl-software.com/cloud/guides/essentials/common-patterns/versioning).

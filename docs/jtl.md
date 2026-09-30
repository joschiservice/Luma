# JTL-Wawi connector

`createJtlConnector` from the connectors composition entry implements `orders.read`, `products.read`, `inventory.read` and `fulfillment.read`. It targets the JTL ERP **2.2** response contract with shared normalization for on-premise and cloud connections. Workflows use `CapabilityReader`; no provider logic belongs in the consuming domain.

## Connection setup

Compose one adapter per trusted Luma tenant and connection. Supply an awaited `recordObservations` persistence hook. Resolve the adapter only after checking current connection ownership and active state on every invocation.

| Connection | Configuration                                                                   | Requests                                                                      |
| ---------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| On-premise | `kind: 'onprem'`, `baseUrl`, `appId`, `appVersion`, `challengeCode`, `apiKey()` | `Authorization: Wawi …`, registered app headers and `api-version: 2.2`        |
| Cloud      | `kind: 'cloud'`, `jtlTenantId`, `accessToken()`                                 | `https://api.jtl-cloud.com/erp/v2/`, `Authorization: Bearer …`, `X-Tenant-ID` |

On-premise `baseUrl` is the API database root, for example `http://127.0.0.1:5883/api/eazybusiness/`. Include the trailing slash; omit a version path. HTTPS is required except for loopback HTTP. Use a trusted HTTPS proxy or local agent for a remote installation. Reject URLs containing credentials, query parameters or fragments. Only trusted connection provisioning may set the destination; never accept it from a capability request.

Credentials resolve on every HTTP request, allowing rotation. The host owns app registration, OAuth token acquisition/refresh and encrypted tenant-scoped credential storage. Register read access for sales orders and their lines, items, warehouse stock, delivery notes and their lines. A licence or permission failure returns `permission_denied`, not an empty page. Confirm that the installation supports the 2.2 endpoints before activation; older API versions are not interchangeable.

Read requests use GET, reject redirects and time out after 15 seconds. `timeoutMs` accepts 1–120,000 milliseconds. There are no global environment credentials or automatically registered connections.

## Mapping

| Capability          | Provider state                                                                  | Canonical behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Orders              | Sales-order overview and complete line-item array                               | Cancelled, open or completed lifecycle from cancellation/delivery status; unknown enum values stay unknown. Fully paid → paid; unpaid → pending. Partial payment stays unknown because the canonical payment enum has no partial-payment state. Original quantities and units are retained; custom lines with item ID zero have no SKU reference. `salesOrderDate` becomes `placedAt`; `totalGrossAmount` with `currencyIso` becomes the total; line name and `sKU` become title and SKU text. Malformed descriptive fields become null without rejecting the order. |
| Products            | Item overview                                                                   | Each JTL item is a product with its own item-ID SKU reference. SKU text preserves case and is never identity. Active/inactive → active/archived. `salesPriceGross` becomes a price without currency, because items do not report one; `gTIN`, `manufacturerName` and `isShopActive` become barcode, vendor and shop activation. Malformed catalog facts become null. Adapter version `jtl/2`.                                                                                                                                                                        |
| Inventory           | Item overview stock totals                                                      | Account-wide on-hand, reserved and available quantities remain independent provider reports. The aggregate location ID is `all-warehouses`. Missing or untracked values remain null; zero, negative and fractional values are preserved.                                                                                                                                                                                                                                                                                                                             |
| Warehouse inventory | Warehouse/item stock endpoint when a warehouse location filter is supplied      | Physical on-hand only. Reserved and available remain null: locked stock is not an order reservation, and warehouse disposable stock is not account-wide sale availability.                                                                                                                                                                                                                                                                                                                                                                                           |
| Fulfillment         | Delivery-note detail, every delivery-note line page, matching sales-order lines | Each delivery note is a separate operation. All packages have shipping dates → shipped; otherwise processing. Line quantities preserve split fulfillment. Progress time is the latest known package shipping date, or note creation time.                                                                                                                                                                                                                                                                                                                            |

Inventory comparisons require explicit mappings between equivalent stock pools. Do not compare `all-warehouses` to a single Shopify location without an aggregation mapping. Product and inventory observations use the item's `modifiedTimestamp` as source update time, and a missing value stays null. The simulator advances it on every stock change. Confirm that an installation also updates it for stock movements: a changed stock level read with an unchanged item time remains history and does not become current.

Order-line IDs include the order ID as their scope. Inventory observations use the item ID scoped to the location. All observations include tenant, connection, provider, observation time, adapter version (`jtl/1`) and schema version. Source revision is null.

The ERP 2.2 sales-order and delivery-note schemas have no modification time, so order and fulfillment observations have a null source update time. Creation, payment and shipping dates are not update times. Canonical projections order these snapshots by observation time: a later read becomes current, so shipments, cancellations and corrected order facts appear on the next read, while a late or replayed older read stays history. The observation time is taken before a read starts. Do not run overlapping reads of the same capability for one connection. See [projection rules](commerce-projections.md#projection-rules).

Unit labels `stk`, `Stück` and `each` map to `each`. Missing or blank item units normalize to `unknown`; they do not default to `each` or pass through configured aliases. Other nonempty labels are retained. Supply `units` for installation-specific canonical aliases; this does not convert quantities. Unknown unit mappings must block cross-provider comparisons. JSON decimal tokens are preserved before JavaScript numeric rounding; unsupported precision is rejected rather than rounded.

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
pnpm exec prettier --write packages/apps/jtl/src/infrastructure/fixtures/erp-2.2.json
```

References: [JTL ERP 2.2 OpenAPI](https://developer.jtl-software.com/openapi/erp/2.2.json), [authentication](https://developer.jtl-software.com/cloud/guides/essentials/authentication/oauth2-flow), [versioning](https://developer.jtl-software.com/cloud/guides/essentials/common-patterns/versioning).

## Shipping-method correction

For a diagnosed `stuck_fulfillment` caused by an incorrect shipping method, `orders.shipping-method.write` changes the sales order to an explicitly mapped replacement method. It requires the order ID, expected current method and replacement method. All references use an empty scope. The replacement must differ from the current method. Cancelled orders, missing methods and stale expected methods reject the action.

Enable `shippingMethodActions: true` only after confirming the installation supports the ERP 2.2 sales-order detail and PATCH endpoints and their idempotency behavior. Installed connections require requested and verified `orders.shipping-method.read` and `orders.shipping-method.write` permissions. The health verifier must confirm JTL `salesorders.read` and `salesorders.write` grants and endpoint support without performing a write. These beta endpoints require an installation-specific sandbox smoke test before activation.

The adapter persists a fresh pre-action observation, then sends only `shippingMethodId` and `disableAutomaticWorkflows: true` to `PATCH sales-orders/{id}`. Credentials, grants and connection state are checked again before the PATCH. The action has **high** minimum risk and runs through the existing execution policy and approval service.

JTL documents an `Idempotency-Key` header on this endpoint. Luma hashes tenant, connection, provider destination, capability and the logical execution key into that header. Execution must reserve the key durably and bind it to immutable intent. The adapter has no local deduplication cache and never retries automatically. A timeout, network loss, malformed response, throttling or server error after dispatch has an unknown effect and requires read-only reconciliation. The PATCH response is an acceptance receipt, not verification. Provider key retention is not specified in the published schema; never redispatch an uncertain attempt after a retention window.

The endpoint has no documented atomic revision precondition. The fresh method comparison detects prior edits but cannot prevent an operator or another integration changing the order between GET and PATCH. Restrict execution to an operationally controlled order with concurrent processing excluded; do not claim compare-and-swap protection. Disabling automatic workflows suppresses workflow triggers for this update, but does not lock shipment processing.

`orders.shipping-method.read` requires `{ order, limit: 1 }` and persists one allowlisted snapshot with the method and cancellation flag. Its evidence is for action verification; it is not a complete canonical order snapshot for ingestion. No customer addresses, arbitrary text or credentials are retained.

`createShippingMethodEffects(runtime, binding)` from connector composition binds this action to the execution service. The host supplies tenant-owned canonical order/method mapping, diagnosis evidence validation and current eligibility checks. The intent target is `order`; `expectedPostcondition.shippingMethodId` must equal the mapped replacement external ID. Verification uses the installed read capability, requires a fresh complete observation of that order, and checks the method and cancellation state. Read or persistence failures remain inconclusive. Verification never writes.

To undo, create a separate policy-evaluated and approved intent with a new logical key, the replacement as the expected current method, and the recorded original method as the destination. Recheck eligibility and verify again. Never automatically compensate an uncertain attempt. A passed method check proves the correction only; resolving the fulfillment incident still requires fresh fulfillment progress evidence or explicit human disposition.

Synthetic tests cover both authentication modes, provider payloads, permission/revocation gates, changed intent, stale state, correction/undo, key reuse across adapter recreation, lost responses and failed verification. The offline schema fixture pins the PATCH body/response and idempotency header against the [published ERP 2.2 contract](https://developer.jtl-software.com/openapi/erp/2.2.json).

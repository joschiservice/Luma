# JTL-Wawi connector

The JTL app reads sales orders, items, stock, delivery notes, suppliers, purchase orders
and, when the connection opts in, customers from JTL ERP API **2.2**, for on-premise (JTL-Wawi) and cloud connections with
shared normalization. It also offers three governed writes: shipping-method correction,
purchase-order submission and return creation. Absence of data is never treated as evidence of shipment,
deletion or confirmation. Code: `@luma/app-jtl`, with the protocol client in
`@luma/connector-jtl`.

## Connections and transport

- **On-premise:** the base URL is the API database root with a trailing slash and no
  version path, for example `http://127.0.0.1:5883/api/eazybusiness/`. HTTPS is required
  except for loopback; reach remote installations through a trusted HTTPS proxy or local
  agent. URLs with credentials, query parameters or fragments are rejected, and only
  trusted provisioning may set the destination. Installed connections also pin the
  endpoint (see [installed connections](installed-connections.md#jtl-on-premise-endpoints)).
- **Cloud:** requests go to the fixed JTL Cloud host with a bearer token and `X-Tenant-ID`.

Credentials are resolved on every request, allowing rotation. Register read access for
sales orders and lines, items, warehouses and their stock, delivery notes and lines,
suppliers, purchase orders, returns and return reasons and, for customer import, customers. A licence or permission failure returns `permission_denied`, never an
empty page. Older API versions are not interchangeable; confirm the installation supports
the 2.2 endpoints before activation. Requests reject redirects and time out after 15
seconds by default.

Errors map to connector codes with `effect: none` for reads; `Retry-After` on 429/503
becomes delay advice. The transport retries short-delay transient reads (see
[connectors](connectors.md#errors-retries-and-evidence)) but never retries a write.
Credentials and provider error text are excluded from failures. Raw capture is off by
default; when enabled it keeps allowlisted parsed fields with an expiry of at most one
year and excludes addresses, customer details, free-text comments, credentials and error
bodies.

## Mapping rules

**Orders.** Lifecycle comes from cancellation and delivery status; unknown values stay
unknown. Fully paid maps to paid and unpaid to pending; partial payment stays unknown
because the canonical enum has no partial state. Original quantities and units are kept;
custom lines with item ID zero have no SKU reference. `externalSalesOrderNumber` is kept
as a marketplace reference for order link suggestions and configured automatic
linking to one selected Shopify store. Malformed
descriptive fields become null without rejecting the order.

**Customers.** Only connections set up with customer import read customers and report each
sales order's `customerId`; customer ID zero or null means no customer. A person's name is
shown with the company in parentheses when both exist, a blank phone falls back to the
mobile number, and locked customers are disabled. Labels become tags. `lastChanged` is the
source update time; JTL's zero date counts as missing. Changed-customer reads use
`lastChangedAfter`, which is exclusive, inside sync's overlapping windows.

**Products.** Each JTL item is a product with its own item-ID SKU reference; SKU text
preserves case and is never identity. `salesPriceGross` becomes a price without currency
because items report none, so it is never compared.

**Inventory.** Without a location filter, item stock totals are account-wide on-hand,
reserved and available quantities under the location ID `all-warehouses`. With a
warehouse filter, only physical on-hand is reported; reserved and available stay null
because locked stock is not an order reservation and warehouse disposable stock is not
sale availability. Never compare `all-warehouses` to a single Shopify location without an
aggregation mapping. Missing or untracked values stay null; zero, negative and fractional
values are preserved. Location filters are warehouse IDs, not bin IDs.

**Fulfillment.** Each delivery note is a separate shipment. It is shipped when every
package has a shipping date, otherwise processing, because the API does not link
packages to line quantities. Line quantities preserve split fulfillment. Packages name a
shipping method key, not a carrier. Delivery notes do not expose work without a note,
carrier delivery confirmation or a reliable failure code; no absence, zero timestamp or
tracking label is treated as shipment or deletion evidence. Missing or duplicate
order-line links within a note reject the page rather than drop or overwrite quantities.

**Units.** `stk`, `Stück` and `each` map to `each`. Missing or blank units normalize to
`unknown` and never default to `each`; other labels are kept. Installation aliases rename
units without converting quantities. Unknown units must block cross-provider
comparisons. JSON decimal tokens are preserved before numeric parsing; unsupported
precision is rejected rather than rounded.

## Ordering and freshness

Items carry `modifiedTimestamp`, used as the source update time for products and
inventory. A later read with the same item time still becomes current, so a stock
movement that leaves the time unchanged appears on the next read; an earlier time never
replaces a later one.

Sales orders and delivery notes have no modification time, so their observations have a
null source update time; creation, payment and shipping dates are not update times. They
are ordered by observation time, which is taken before a read starts. **Do not run
overlapping reads of the same capability for one connection.** See
[projection rules](commerce-projections.md#projection-rules).

## Pagination

`limit` is 1–100 parent records. Cursors bind tenant, connection, destination, cloud
tenant, capability, page size, filters and unit mapping; preserve them unchanged.
Inconsistent page numbers, counts or continuation metadata reject the read. Child reads
(order lines, delivery-note details and lines, warehouse stock) run at most four at a
time in page order, and a child failure rejects the whole parent page. Delivery-note lines
are fully paginated with duplicate detection and a 1,000-page ceiling.

A SKU-filtered inventory read fetches that item directly as a single page; an unknown
item yields an empty page. A fulfillment order filter uses `salesOrderNumberId` and
checks the returned order identity. Offset pagination is not a transactional snapshot:
concurrent changes can shift records between pages. Only a successful full scan supports
absence checks, and no read emits inferred tombstones.

The consumed response shapes are pinned in an offline fixture extracted from JTL's
[published ERP 2.2 OpenAPI](https://developer.jtl-software.com/openapi/erp/2.2.json);
refresh it with `node apps/api/scripts/update-jtl-schema.mjs` and review the diff. A live
smoke test remains necessary for each installation's version, permissions and network
route.

## Shipping-method correction

For a diagnosed `stuck_fulfillment` caused by a wrong shipping method,
`orders.shipping-method.write` changes the sales order to an explicitly mapped
replacement. It takes the order, the expected current method and the replacement; the
replacement must differ. Cancelled orders, missing methods and stale expected methods are
rejected. The action has **high** minimum risk and runs through execution policy and
approval.

Activation requires requested and verified `orders.shipping-method.read` and `.write`,
backed by confirmed JTL `salesorders.read` and `salesorders.write` grants, without the
verifier performing a write. These beta endpoints need an installation-specific sandbox
smoke test of the detail and PATCH endpoints and their idempotency behavior first.

- The adapter persists a fresh pre-action observation, rechecks credentials, grants and
  connection state, then sends only `shippingMethodId` and
  `disableAutomaticWorkflows: true`. Disabling workflows suppresses triggers for this
  update; it does not lock shipment processing.
- **No compare-and-swap.** The endpoint has no atomic revision precondition. The fresh
  method comparison detects prior edits but cannot stop a change between read and PATCH.
  Restrict execution to operationally controlled orders with concurrent processing
  excluded.
- The `Idempotency-Key` hashes tenant, connection, destination, capability and the
  logical execution key. Execution must reserve it durably and bind it to immutable
  intent. JTL does not specify key retention, so never redispatch an uncertain attempt.
  A timeout, network loss, malformed response, throttling or server error after dispatch
  has an unknown effect and needs read-only reconciliation.
- `orders.shipping-method.read` persists one allowlisted snapshot with the method and
  cancellation flag. It is verification evidence, not a canonical order snapshot.
- The host binding supplies tenant-owned order and method mappings, diagnosis evidence
  validation and current eligibility checks. The expected postcondition's method must
  equal the mapped replacement. Verification needs a fresh complete observation of the
  order; read or persistence failures remain inconclusive.

To undo, create a separate, policy-evaluated and approved intent with a new logical key,
the replacement as the expected current method and the recorded original as destination,
then verify again. Never compensate an uncertain attempt automatically. A passed method
check proves the correction only; resolving the fulfillment incident still needs fresh
fulfillment progress or explicit human disposition.

## Purchase orders

`suppliers.read` pages JTL's supplier overview, which lists only active default-type
suppliers, so overview rows are reported active and without email. A `supplier` filter
reads the detail regardless of activity and adds `isActive` and the contact email. No
address, phone or note is read.

`purchase-orders.read` reads purchase-order details by ID, pages all orders (`limit`
1–25, one detail read each), or finds orders created for a Luma purchase order: with
`created`, it scans orders created since the given time, at most 500 within five pages,
for the internal comment marker `luma-po:<lumaOrderId>`. A scan that exceeds that bound is
`partial`. Only item positions become lines, and `sku` is the item ID, matching product
and inventory reads. Unrecognized statuses are `unknown`. The internal comment is reduced
to the marker; its text, addresses, prices and notes are never returned or captured.

- Confirmation fields record what JTL holds about the supplier's confirmation; null means
  none is recorded. `deliveredQuantity` is goods receipt booked in JTL. Neither is
  independent evidence from the supplier.
- ERP 2.2 purchase-order lines carry no unit. Lines of orders carrying exactly one Luma
  marker report `each`, because Luma submits only countable items; other orders report
  `unknown` and must not be compared by quantity.

`purchase-orders.submit` creates one order (**high** minimum risk, `provider_key`
idempotency, a single attempt). It requires granted `purchase-orders.read` because it
reads before writing. Quantities must be positive and in `each`.

- Luma does not own purchase prices: each line's net price and VAT rate come from the
  item's assignment for the order's supplier. A missing assignment, price or VAT rate
  refuses before dispatch with `conflict`.
- It refuses with `conflict` if an order marked for the same Luma order exists in the
  last 24 hours or that scan is incomplete. Pre-dispatch read failures keep their code
  and are marked `not_dispatched`.
- The body carries the supplier, the requested date at midday UTC, the priced items, the
  reference as `externalOrderNumber` (truncated to 255 characters) and the marker in the
  internal comment, which JTL does not send to the supplier. Automatic workflows stay
  enabled: the merchant's JTL workflows send the order to the supplier.
- The `Idempotency-Key` is derived as for shipping-method corrections. A 201 returns the
  JTL purchase-order ID as the only evidence reference; it means JTL recorded the order,
  not that the supplier received or confirmed it.
- Rejections (400, 401, 403, 404, 409, 412) have no effect. A timeout, network loss,
  throttling, server error or malformed response after dispatch has an unknown effect;
  reconcile by reading `created` with the Luma order ID. Never redispatch an uncertain
  submission.

The verifier grants `suppliers.read` and `purchase-orders.read` from read probes. Probes
cannot establish the `purchaseorders.write` grant, so only simulated installations that
pass the purchase-order and item probes receive `purchase-orders.submit`. On-premise
connections allow `POST` through the pinned transport only for this capability and return
creation. See
[supplier commitments](supplier-commitments.md) for how Luma uses these reads.

## Returns

JTL returns serve Luma return cases. Luma's return case owns inspection and resolution;
JTL returns are not imported into the Returns list, and `returns.read` is not offered.

`returns.options.read` lists the choices a return needs: every active warehouse (resource
`location`, at most ten pages of 100; more is `partial`) and every return reason (resource
`return_reason`). A reason's name is its English translation, else German, else the first.

`returns.created.read` finds the returns created for one Luma return case. It scans the
order's returns, at most 500 within five pages, for the exact marker
`luma-rc:<lumaCaseId>` in `externalNumber`, which JTL accepts only at creation and never
changes. A longer scan, or more matches than `limit`, is `partial`. Each match reports its
number, date, warehouse and lines; a line's order line uses the sales-order ID as scope
key, as in `orders.read`, and its quantity is in `each`. Comments, contact and customer
fields are never read. The result is verification evidence, not a canonical return.

`returns.create` creates one return (**high** minimum risk, `provider_key` idempotency, a
single attempt) for one order, warehouse and reason; the reason applies to every line.

- Every line must be a line of the order, counted in `each`, with a positive quantity no
  larger than the ordered quantity. A cancelled order, a quantity above the ordered
  quantity or a line in another unit refuses with `conflict`; a line outside the order
  with `invalid_input`.
- It refuses with `conflict` if a return marked for the same case exists or that scan is
  incomplete. Pre-dispatch read failures keep their code and are marked `not_dispatched`.
- The body carries the order's company, the order, warehouse, marker, the internal comment
  `Created by Luma` and one item per line with `credit: false`, so JTL books no credit. No
  customer text is sent.
- The `Idempotency-Key` is derived as for shipping-method corrections. ERP 2.2 does not
  document the header for this endpoint, so duplicates are ruled out only by the marker
  check. A 201 returns the JTL return ID as the only evidence reference; it means JTL
  recorded the return, not that any item came back.
- Rejections (400, 401, 403, 404, 409, 412) have no effect. A timeout, network loss,
  throttling, server error or malformed response after dispatch has an unknown effect;
  reconcile by reading `returns.created.read` with the case ID. Never redispatch an
  uncertain creation.

The verifier grants `returns.options.read` when the warehouse and return-reason probes
pass and `returns.created.read` when the return probe passes. Probes cannot establish the
`returns.write` grant, so only simulated installations that pass both return probes and
the sales-order probe receive `returns.create` until an installation-specific sandbox
smoke test exists.

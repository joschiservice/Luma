# Commerce sync

Commerce sync imports each connection's history into the canonical projections, keeps
it current and reconciles it against the source. It reads through installed connection
capabilities and never writes to a source.

## Streams, scans and runs

A **stream** exists per connection and record type (`orders`, `fulfillments`,
`products`, `inventory`, `customers`, `returns`) whose read capability the connection grants.
The runner creates streams for active connections, running as the person who first
installed the connection. Each stream has one active **scan**, with a suspended history checkpoint during a live read; every scan is a
**run** in `commerce_sync_runs`.

| Scan          | When                                                       | Reads                                    |
| ------------- | ---------------------------------------------------------- | ---------------------------------------- |
| `backfill`    | Once after the stream is created, or on **Re-import**      | Every record the source shares           |
| `incremental` | Every 5 minutes, or 10 seconds after a change notification | Records changed since the last scan      |
| `reconcile`   | Daily, or on **Check all records**                         | Every record; flags records not returned |

Incremental reads send `updatedSince` (the previous scan's start minus a 10-minute
overlap) only to handlers whose descriptor lists `filters: ['updatedSince']`. Other
handlers are reread in full every 30 minutes. The overlap and daily full check cover
clock skew and missed notifications; ordering of snapshots still follows the
projection rules, not these times. Fulfillment and return history waits for the
connection's order history, or its completed recent window where supported. The returns stream stores both returns and refunds in its
ledger.

## Pages, checkpoints and retries

The runner leases one stream (5 minutes) and requests a page of 100 records; adapters
may return fewer (Shopify returns at most 25, or 5 for fulfillments and returns). It
imports the page's changed records in one ingestion transaction, then commits the ledger
entries, counters and next cursor in one transaction. A restarted or second runner
continues from the committed cursor; a lost lease discards the page's ledger write, and
the next attempt re-imports idempotently.

Provider transports first repeat a failed read briefly (see
[connectors](connectors.md#errors-retries-and-evidence)), so a single transient
request failure rarely fails a page. Page failures keep the cursor and back off from
30 seconds to at most an hour, honoring `retryAfterMs`. `failing_since` records when the
current run of failures began; a successful page clears it. Scheduled detection uses it
for the sync-failure retry window
([exception detection](exception-detection.md#scheduled-detection)). A rejected cursor restarts the scan. After five consecutive failures
the stream is **failing**. Messages are controlled text by connector error code;
provider text is never stored. A stream whose person no longer manages the
workspace is blocked until an owner or admin resumes it, which makes them the
stream's person. Streams stop while their connection is inactive or no longer grants
the capability, and restart when it returns.

A record that fails Luma's validation is marked `failed` in the ledger with a
controlled problem and does not stop the page: the page's ingestion transaction is
rolled back and its records are imported one at a time, so only that record fails. Records whose related records are not
imported yet (for example a fulfillment before its order) are `pending` and retried
on the next scan.

## Ledger and coverage

`commerce_sync_items` holds one row per source record: a digest of the normalized
observation, status, source creation and update times, first/last seen and the last
scan that saw it. A record whose digest and status are unchanged is not projected
again, so re-imports and duplicate notifications add no snapshots. Full scans set
`missing_since` on records they no longer return; nothing is deleted.

Coverage per stream comes from the ledger (counts, oldest/newest creation date) and
from the page `history` limit. `history_from` is the limit reported when the history
import started; a later scan without a limit sets `olderHistoryAvailable`. Shopify
reports a 60-day order window unless `read_all_orders` is granted. Pages also report
`total` when the source counts the collection cheaply; it only drives progress.

Imports use `ingestion.import` (see
[commerce projections](commerce-projections.md#imports-products-and-links)).
Observations are stored with ingest key `sync:<observation id>`. Read checks record
each page outcome for connection freshness; only product pages keep their items.

## Change notifications

Shopify connections subscribe to order, fulfillment, product, inventory-level, refund,
return and, when approved, customer topics at `/api/v1/shopify/changes/:organizationId/:connectionId`.
The route verifies the HMAC and shop, then inserts a `connector_refresh_hints` row
(deduplicated by event) before acknowledging. The runner turns hints into stream
`hint_at` times. Notification bodies are never imported. Existing connections
subscribe on their next authorization.

## Customers

`customers.read` returns profiles only when the deployment sets
`SHOPIFY_PROTECTED_CUSTOMER_DATA_APPROVED`; contact fields also need
`SHOPIFY_CUSTOMER_CONTACT_APPROVED` and addresses `SHOPIFY_CUSTOMER_ADDRESS_APPROVED`.
Profiles bypass observation storage: `customer_profiles` (owned by `@luma/customers`)
keeps only the current version, and customer read checks carry no items.
`customers/redact` and `shop/redact` intake calls `erase_shopify_customer_data` in the
intake transaction, which deletes the profiles and ledger rows and remembers erased
customer IDs by digest so later reads skip them. Other retained data still follows the
[privacy operations](shopify-production.md#privacy-operations) workflow.

## Links

SKU, location and order links are requested through the API (`commerce_identity_links`) and
applied by the runner with the requester's current permissions, because only the
worker login may write projections. Suggestions come from equal normalized SKU codes
in other connections. Order suggestions require a JTL external marketplace order number
matching a Shopify order number. Dates and totals support review; neither establishes identity.
Multiple candidates stay visible and are never applied automatically.

Order link/unlink runs in one ingestion transaction that holds the tenant's ingestion
lock exclusively. Imports hold it shared, so a link waits for running imports and new
imports wait for the link. Children
receive canonical IDs keyed by the current order mapping revision; parent bindings remain
immutable. Old pointers are retired by the orders owner, with snapshots and actor/reason history
retained. Redirects preserve old order and child links, cases and activity. The order list, search,
Home metrics and Insights read current projections and count the linked order once.
A restart before commit rolls back the change; a restart after commit resumes the request
without reapplying effects.

## Running it

`pnpm dev` starts the sync process (`apps/worker`, `src/sync-bootstrap.ts`). In
production run `pnpm --filter @luma/worker start:sync` with `WORKFLOW_DATABASE_URL`, the
identity settings, `CONNECTIONS_ACTIVE_KEY_ID`/`CONNECTIONS_KEYS`, provider settings and
optionally `COMMERCE_SYNC_CONCURRENCY` (tenants in parallel, default 4). Several
processes can run; leases keep each page with one of them. The worker login needs
`luma_commerce_sync` and `luma_customers` in addition to the commerce owner roles;
the API login needs `luma_commerce_sync`. Simulated connections without a local
transport report unavailable and back off.

## Validation

`packages/commerce-sync/src/domain/*.test.ts` covers scheduling, backoff, status and
coverage rules. `packages/application-runtime/src/commerce-sync.integration.test.ts`
runs the store, runner, ingestion and customer profiles against PostgreSQL: paged
import with checkpoints, re-import without duplicates, out-of-order updates, retry
from a checkpoint, fulfillments after orders, missing-record detection, change
notifications, customer erasure and suppression, SKU and order link/unlink, stale replays, interrupted order linking, reference
redirects, ambiguous suggestions, tenant isolation and principal recovery. It also covers
page imports that fail only a rejected record, concurrent imports of overlapping streams
and connections, and imports sharing the ingestion lock while a link waits. Shopify adapter tests validate the new queries against the 2026-07 schema.
The web Data sync page has `Data sync/Workspace` stories and presentation tests.

Set `LUMA_IMPORT_BENCHMARK=<records>` when running that test file to measure end-to-end
history imports through the runner with production defaults and an in-memory source
without latency. Results are written to `/tmp/luma-import-benchmark-<records>.json`. On
October 6, 2026, PostgreSQL 17 in Docker on a development laptop with durable commits
measured, for 2,000 records per stream:

| Stream                                 | Before batched imports | After |
| -------------------------------------- | ---------------------: | ----: |
| Products, records/s                    |                    126 |   908 |
| Inventory, records/s                   |                    200 | 1,515 |
| Orders with two lines, records/s       |                     41 |   399 |
| Fulfillments, records/s                |                     71 | 1,056 |
| Orders from two connections, records/s |                     39 | 1,040 |

These figures exclude provider latency and rate limits. Order imports are now limited
mostly by search indexing of order mappings and the order list refresh.

## Recent history, live reads and exports

Shopify order, fulfillment and return backfills first read a 30-day creation window,
newest first. The durable `recent_history_from` and `recent_history_completed_at`
checkpoint distinguishes that window from completed full history. Recent child
streams may start after recent orders finish; providers without `createdSince`
retain the full-order dependency. A second scan reads the complete history the
source shares. Shopify's 60-day limit still applies without `read_all_orders`.
A recent-window read never establishes absence or full-history coverage.

The workspace runs up to `COMMERCE_SYNC_WORKSPACE_CONCURRENCY` pages concurrently
(default 4, range 1–8). Admission per connection is limited by
`COMMERCE_SYNC_CONNECTION_CONCURRENCY` (default 2, range 1–4), including leases held
by other processes. The workspace page limit also counts leases across processes;
use the same concurrency settings on all sync workers. `COMMERCE_SYNC_CONCURRENCY` still limits parallel workspaces.
A short tenant advisory lock serializes admission; provider reads run outside it.
The worker pool allows `tenant concurrency × workspace concurrency × 2 + 2`
connections. Size PostgreSQL's connection limit for the total number of workers.

Pages of one workspace import concurrently. Owners take the order and inventory entity
locks of a page in sorted order, and new entities and mappings are inserted in sorted
order, so overlapping pages (for example orders and their fulfillments) wait for each
other instead of deadlocking. If PostgreSQL still cancels a transaction to break a lock
cycle, the page's import is retried once before the page fails.

Idle hints and incremental scans precede history pages. During an active scan,
only `due_at` makes its next page eligible; a saved hint cannot bypass failure
backoff. At a page boundary, a due live read can suspend a filterable history scan.
Its cursor, counters and export state are persisted, then restored after the live
scan finishes. Live reads also run every five minutes during long history imports.
A provider cooldown defers the entire connection, including hinted work. Shopify
clients share a budget per tenant/connection, using requested query cost, refunded
balance, restore rate and `Retry-After` before sending the next request.

Full Shopify backfills of orders, products, inventory and permitted customers use
Bulk Operations on Admin API 2026-07. Recent windows, incremental reads and full
checks remain paged. A stable, hashed scan alias identifies an export, allowing
recovery after a lost start response without repeating the mutation. An opaque
cursor stores the operation ID, byte offset and root count. Preparing exports
release their lease and poll later; they do not record successful reads or coverage.
The adapter queues when all five query slots are occupied.

Completed exports are streamed as grouped JSONL in chunks of 500 root records.
Children are joined through `__parentId` before normalizing a complete observation.
The file is never saved. The ledger and cursor commit together, so replay after a
crash recognizes unchanged records. The final root count must match the completed
export's count. Failed, canceled, expired, malformed or truncated exports never
complete coverage. Retry transient download failures; use **Re-import history** to
start a new export when its operation or seven-day download URL is no longer usable.
Customer selections obey the same protected-data approvals as paged reads, and
customer read checks contain no profiles.

See [connector import measurements](connectors.md#import-read-patterns-and-measurements)
for reproducible simulator measurements and their limits.

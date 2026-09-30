# Commerce sync

Commerce sync imports each connection's history into the canonical projections, keeps
it current and reconciles it against the source. It reads through installed connection
capabilities and never writes to a source.

## Streams, scans and runs

A **stream** exists per connection and record type (`orders`, `fulfillments`,
`products`, `inventory`, `customers`) whose read capability the connection grants.
The runner creates streams for active connections, running as the person who first
installed the connection. Each stream runs one **scan** at a time; every scan is a
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
projection rules, not these times. Fulfillment history waits for the connection's
order history.

## Pages, checkpoints and retries

The runner leases one stream (5 minutes), reads one page of 25 records, imports it and
commits the ledger entries, counters and next cursor in one transaction. A restarted
or second runner continues from the committed cursor; a lost lease discards the
page's ledger write, and the next attempt re-imports idempotently.

Failures keep the cursor and back off from 30 seconds to at most an hour, honoring
`retryAfterMs`. A rejected cursor restarts the scan. After five consecutive failures
the stream is **failing**. Messages are controlled text by connector error code;
provider text is never stored. A stream whose person no longer manages the
workspace is blocked until an owner or admin resumes it, which makes them the
stream's person. Streams stop while their connection is inactive or no longer grants
the capability, and restart when it returns.

A record that fails Luma's validation is marked `failed` in the ledger with a
controlled problem and does not stop the page. Records whose related records are not
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

Shopify connections subscribe to order, fulfillment, product, inventory-level and,
when approved, customer topics at `/api/v1/shopify/changes/:organizationId/:connectionId`.
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

SKU and location links are requested through the API (`commerce_identity_links`) and
applied by the runner with the requester's current permissions, because only the
worker login may write projections. Suggestions come from equal normalized SKU codes
in other connections; they are never applied automatically.

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
notifications, customer erasure and suppression, SKU link/unlink and principal
recovery. Shopify adapter tests validate the new queries against the 2026-07 schema.
The web Data sync page has `Data sync/Workspace` stories and presentation tests.

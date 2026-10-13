# Commerce sync

Commerce sync imports each connection's history into the
[canonical projections](commerce-projections.md), keeps it current and reconciles it
against the source. It reads only through installed connection capabilities and never
writes to a source. Code: `@luma/commerce-sync`; the process runs in `apps/worker`.

## Streams, scans and runs

A **stream** exists per connection and record type (`orders`, `fulfillments`, `products`,
`inventory`, `customers`, `returns`) whose read capability the connection grants. Each
stream runs as a person, initially the one who installed the connection, with that
person's current permissions. Each stream has one active **scan**; every scan is a
**run**.

| Scan          | When                                                       | Reads                                    |
| ------------- | ---------------------------------------------------------- | ---------------------------------------- |
| `backfill`    | Once after the stream is created, or on re-import          | Every record the source shares           |
| `incremental` | Every 5 minutes, or 10 seconds after a change notification | Records changed since the last scan      |
| `reconcile`   | Daily, or on **Check all records**                         | Every record; flags records not returned |

Incremental reads send `updatedSince` (the previous scan's start minus a 10-minute
overlap) only to handlers that declare `filters: ['updatedSince']`; other handlers are
reread in full every 30 minutes. The overlap and the daily full check cover clock skew and
missed notifications. Snapshot ordering still follows the
[projection rules](commerce-projections.md#projection-rules), not these times.
Fulfillment and return history waits for the connection's order history, or its
completed recent window where supported.

## Pages, checkpoints and retries

The runner leases one stream for 5 minutes and requests a page of 100 records; adapters
may return fewer (Shopify returns at most 25, or 5 for fulfillments and returns). It
imports the page's changed records in one ingestion transaction, then commits ledger
entries, counters and the next cursor in one transaction. A restarted or second runner
continues from the committed cursor; a lost lease discards the page's ledger write, and
the next attempt re-imports idempotently.

Transports first retry a transient read briefly (see
[connectors](connectors.md#errors-retries-and-evidence)). A page failure keeps the cursor
and backs off from 30 seconds to at most an hour, honoring `retryAfterMs`. A rejected
cursor restarts the scan. After five consecutive failures the stream is **failing**.
`failing_since` marks when the current run of failures began and is cleared by a
successful page; scheduled detection uses it for the sync-failure retry window
([exception detection](exception-detection.md#scheduled-detection)). Stored messages are
controlled text by connector error code; provider text is never stored.

A record that fails Luma's validation is marked `failed` with a controlled problem
without failing the page: the page transaction rolls back and its records are imported
one at a time. Records whose related records are not imported yet, such as a fulfillment
before its order, are `pending` and retried on the next scan. If PostgreSQL cancels a page
transaction to break a lock cycle, the import is retried once before the page fails.

A stream whose person no longer manages the workspace is blocked until someone with
`sync.manage` resumes it, which makes them the stream's person. Streams stop while their
connection is inactive or no longer grants the capability, and restart when it returns.

A suspended or closed workspace is paused, not blocked. Discovery skips it, so its streams,
link requests and automatic link rules keep their state and nothing is recorded as a
failure. A page that started just before the suspension stops without changing its stream
and runs again once its lease expires; a link request in progress goes back to waiting.
Change notifications are still acknowledged and stored as hints, and Shopify privacy
requests are always processed. After reactivation the stored hints and due streams run
like any other, and scheduled scans cover what changed meanwhile.

## Ledger and coverage

The ledger holds one row per source record: a digest of the normalized observation,
status, source creation and update times, first/last seen and the last scan that saw it.
A record whose digest and status are unchanged is not projected again, so re-imports and
duplicate notifications add no snapshots. Full scans set `missing_since` on records they
no longer return, and any later read that returns the record clears it. Missing is not deletion.
For Shopify orders, products and stock positions, the next due read checks up to ten missing
records independently before reading its page. Current grants must permit the lookup; older
orders with unknown creation time or outside the 60-day window require `read_all_orders`.
A complete, error-free null point lookup confirms deletion; a readable inventory item with
no level at the previously observed location confirms disconnection. Failed, partial or
history-limited lookups keep current projections and retry later. A record that reappears
keeps its mappings and can become current again through the normal freshness rules.

Confirmation stores a new tombstone observation and owner snapshot before marking the
ledger record retired. A restart between those writes repeats the confirmation safely.
Retirement affects only that connection, preserves mappings, evidence and linked issues,
and excludes retired facts from current lists, comparisons, metrics and detection. Signed
deletion hints request full reconciliation; scheduled full scans cover missed delivery.
Customer profile retention follows the separate policy below. The returns stream's ledger holds both returns
and refunds.

Coverage per stream comes from the ledger (counts, oldest and newest creation date) and
from the page `history` limit. `history_from` is the limit reported when the history
import started; a later scan without a limit reports that older history is available.
Shopify limits orders to 60 days unless `read_all_orders` is granted, and granting it does
not backfill: an operator re-imports order history. Page `total` drives progress only.

Observations are stored with ingest key `sync:<observation id>`. Each page outcome is
recorded as a read check for connection freshness; only product pages keep their items.

## Change notifications

Shopify connections subscribe to order, fulfillment, product, inventory-level, refund,
return and, when approved, customer topics. The change route verifies the HMAC and shop,
then stores a deduplicated refresh hint before acknowledging; the runner turns hints into
stream hint times. Notification bodies are never imported. Existing connections subscribe
on their next authorization. Subscriptions are best effort; scheduled scans still cover
every record.

## Customers

Shopify's `customers.read` returns profiles only when the deployment sets
`SHOPIFY_PROTECTED_CUSTOMER_DATA_APPROVED`; contact fields also need
`SHOPIFY_CUSTOMER_CONTACT_APPROVED`, and default addresses
`SHOPIFY_CUSTOMER_ADDRESS_APPROVED`. JTL offers `customers.read` only for connections set up
with customer import and reads changed customers with `lastChangedAfter`. JTL has no separate
consent for contact and address fields and reports no order count or spend. Profiles bypass
observation storage: `@luma/customers` keeps only the current version, and customer read
checks carry no items.

When a connection grants `customers.read`, its order reads also report the customer who
placed each order. Sync removes that reference before recording the order observation and
stores it as an order link in `@luma/customers`, keyed by source order: a later read moves
the order to another customer, and a read without a customer removes the link. Orders
imported before a connection reported customers get links on their next full reread.

Order delivery and billing addresses follow the same path. Shopify reports them only with
address approval and otherwise reports them as not shared. Sync removes them from the order
observation and stores the latest report per source order in `@luma/customers`; an older read
never replaces a newer one. Order detail shows them only to people who can read customers.

A `customers/redact` or `shop/redact` request erases the affected imported profiles, their
order links, order addresses and ledger rows in its intake transaction. A customer redaction
erases the addresses of the customer's linked orders and of the orders it lists, even when it
names no Shopify customer ID; a shop redaction erases every address of the shop. Erased
customer and order IDs are remembered by digest, so later reads skip them, their orders get
no new links and those orders' addresses are not stored again. Erasing customers through
`@luma/customers` does the same for their linked orders. Erasure and customer imports of one
connection take the same lock, so a read that started earlier cannot restore erased data. Other retained data still follows the
[privacy operations](shopify-production.md#privacy-operations) procedure.

Sources do not always ask for erasure; JTL never does, so a customer deleted at the source
is only seen as absent from full reads. One absent read is not proof, because a source fault
or permission change can hide records too. So the profile stays, marked as missing, until it
has been missing for 30 days (`missingCustomerRetentionMs`). The final page of the next
complete full read then removes the profile and its order links and forgets the ledger rows,
in batches of up to 1000 per read. Order addresses stay, because they belong to orders the
source still reports. Customers on that page, or already seen earlier in that
read, are never removed. Removal is not an erasure: no digest is kept, so a customer the
source reports again is imported as new. Order links follow the source's reassignment, so
orders of a customer merged into another one move to the remaining customer on the next
full read.

## Links

SKU, location and order links are requested through the API and applied by the runner
with the requester's current permissions, because only the worker login may write
projections. Suggestions come from equal normalized SKU codes in other connections. Order
suggestions require an ERP order's (JTL, Cin7) external marketplace order number matching
a Shopify order number; dates and totals support review but never establish identity. Multiple candidates
stay visible and require review.

Automatic linking is opt-in for a selected connection pair and record type. SKU rules
match a nonempty code after lowercasing and trimming surrounding spaces; each connection
must identify exactly one SKU with that code, with equal known units. Order rules match an
ERP order's external marketplace reference to the order number in one selected Shopify
store; any non-Shopify connection can be the ERP side.
Order references preserve case and ignore surrounding spaces and `#`. Automatic
order rules skip records already linked outside their selected connection pair. Dates, totals and
customer details never establish identity. Source products and fulfillment operations
remain separate.

Both streams need a completed full read and a successful read within the last day. Full
reads cover the history the provider grants, including any reported history limit.
Paused, blocked, failing or incomplete scans, and pending or failed imports, stop matching.
Each candidate must still have current, recently seen ledger evidence. A read of an older
provider version cannot refresh a newer retained projection's identity evidence. Duplicate keys,
multiple source identities, conflicting units or overlapping connection mappings are
skipped. Any source identity with a recorded manual unlink stays excluded from automatic
rules; a person can link it again explicitly. Pending manual requests take precedence.

Rule saves require current `sync.manage`, check the expected revision and append the
configuring actor and enabled state to immutable history. Rules run with that person's
current access. Lost access blocks a rule until a manager previews and enables it again.
Disabling stops future links and preserves existing ones. The worker checks enabled rules
once a minute, in batches of at most 20 non-overlapping matches. Preview uses the same
rules but writes nothing; each application rechecks current evidence under the exclusive
ingestion lock and commits mapping revisions, replay and progress together. A failed
attempt rolls back and retries. Every automatic mapping revision names its rule and
configuration revision.

Link and unlink wait for running imports and block new ones (see
[commerce projections](commerce-projections.md#imports-products-and-links)). Redirects
preserve old order and child links, cases and activity. Order lists, search, Home metrics
and Insights read current projections and count a linked order once. A restart before
commit rolls back the change; a restart after commit resumes the request without
reapplying effects.

## Recent history, live reads and exports

Shopify order, fulfillment and return backfills first read a 30-day creation window,
newest first, then a second scan reads the complete history the source shares. A durable
checkpoint distinguishes the completed recent window from completed full history. Recent
child streams may start after recent orders finish; providers without `createdSince` keep
the full-order dependency. A recent-window read never establishes absence or full-history
coverage.

Scheduling order: idle hints and incremental scans precede history pages. During an
active scan, only its due time makes the next page eligible; a hint cannot bypass failure
backoff. At a page boundary a due live read can suspend a filterable history scan; its
cursor, counters and export state are persisted and restored afterwards, so live reads
still run every five minutes during long imports. A provider cooldown defers the entire
connection, including hinted work. Shopify clients share a query-cost budget per tenant
and connection.

Full Shopify backfills of orders, products, inventory and permitted customers use Bulk
Operations; recent windows, incremental reads and full checks stay paged.

- A stable, hashed scan alias identifies an export, so a lost start response recovers
  without repeating the mutation. The cursor stores the operation ID, byte offset and
  root count. Preparing exports release their lease and poll later; they record no
  successful read or coverage. The adapter queues when all five query slots are occupied.
- Completed exports stream as grouped JSONL in chunks of 500 root records, joining
  children through `__parentId` before normalizing. The file is never saved.
- Each observation's `observedAt` is the export's `createdAt`, because the file shows the
  shop when the export started; freshness checks then treat old exports as old.
- The ledger and cursor commit together, so replay after a crash recognizes unchanged
  records. The final root count must match the export's count. Failed, canceled, expired,
  malformed or truncated exports never complete coverage.
- Transient download failures are retried. When the operation or its seven-day download
  URL is no longer usable (`export_unavailable`), start a new export with **Re-import
  history**.

## Concurrency and running it

Several sync processes can run; leases keep each page with one of them. Limits:

- `COMMERCE_SYNC_CONCURRENCY` (default 4): workspaces in parallel per process.
- `COMMERCE_SYNC_WORKSPACE_CONCURRENCY` (default 4, 1–8): concurrent pages per workspace.
- `COMMERCE_SYNC_CONNECTION_CONCURRENCY` (default 2, 1–4): concurrent pages per
  connection.

The workspace and connection limits count leases held by other processes, so use the same
settings on every sync worker. A short tenant advisory lock serializes admission; provider
reads run outside it. Each worker's pool allows `tenant concurrency × workspace
concurrency × 2 + 2` database connections; size PostgreSQL's connection limit for all
workers together.

`pnpm dev` starts the sync process. In production run it with the workflow database URL,
identity settings, the connection keyring, provider settings and the concurrency settings
above. The worker login needs `luma_commerce_sync` and `luma_customers` in addition to the
commerce owner roles; the API login needs `luma_commerce_sync`. Simulated connections
without a local transport report unavailable and back off.

To measure end-to-end import throughput through the runner against PostgreSQL, set
`LUMA_IMPORT_BENCHMARK=<records>` when running the commerce sync integration test in
`@luma/application-runtime`. It uses an in-memory source without latency, so results
exclude provider latency and rate limits; order imports are limited mostly by order
mapping search indexing and the order list refresh. Provider-side read patterns are
covered in [connector import measurements](connectors.md#import-read-patterns-and-measurements).

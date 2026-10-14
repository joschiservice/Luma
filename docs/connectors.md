# Connector capabilities

Connectors expose provider systems to Luma as typed, versioned capabilities. Consumers
select a connection and capability; adapters own provider mapping, credentials and
API/browser interaction, and no domain rule inspects the provider or mechanism. Reads
return observations with provenance; writes return acceptance receipts that never count
as verified success.

Code: the capability contract and runtime live in `@luma/connections`, shared transport
and errors in `@luma/connector-core`, and provider adapters in the workspace apps
([Shopify](shopify.md), [JTL](jtl.md), [Cin7](cin7.md), [Starshipit](starshipit.md), [Gmail](gmail.md)). Tenant setup, encrypted credentials and
permission-gated composition are covered in [installed connections](installed-connections.md).

## Contract

Each capability key selects its own input and output types; the capability map in
`@luma/connections` is the reference. Write capabilities are deliberately narrow (for
example, order writes only cancel). Adapters advertise only operations they implement with
the declared semantics; a different operation needs a contract change.

- Handlers that declare `filters: ['updatedSince']` accept `updatedSince` and return only
  records changed since then; others reject it. Never represent a creation filter as an
  update filter.
- `orders.read` handlers that declare `order` read exactly that order by source ID: one
  observation, or an empty complete page when the source no longer has it, never a cursor.
  The observation must equal what a scan emits for that order. Shopify, JTL and Luma ERP
  support it.
- The first page of a scan may report `total` (progress only) and `history`: the earliest
  creation time the source shares with this connection and the permission that lifts the
  limit.
- Decimals are strings with at most fourteen integer and six fractional digits. Preserve
  negative and fractional inventory, unknown/null values and source revisions. Order-line
  `cancelledQuantity` is null when the source cannot distinguish cancellations from
  refunds or edits.
- External IDs are opaque and case-sensitive. `scopeKey` is the parent namespace for local
  IDs, or empty for account-wide IDs. Tenant, connection, provider and resource complete
  the source identity. Canonical IDs come only from tenant-owned mappings; SKU text is not
  identity.

Read results contain observations and pagination metadata. `nextCursor` is opaque and
bound to the connection and query. `completeness: complete` means the requested page is
fully represented; only a successful scan of every page establishes collection
completeness. A failed scan, filtered query or partial page cannot establish deletion, and
tombstones are always explicit. The one exception is the [order refresh](orders-workspace.md#refreshing-an-orders-sources):
a complete read of one order's fulfilment records covers that order completely, so unshipped
work it no longer returns is retired. Each observation carries source identity, observation ID
and time, source revision and time, adapter version and schema version. Persist
observations with stable ingestion keys before projection, and never overwrite absent
fields from a partial provider event.

## Implement an adapter

A connection supplies its tenant/connection identity, state, provider, adapter version,
executor provenance and a partial map of capability handlers. Each handler has:

- `parseInput` and `parseOutput`: runtime validation that rejects invalid decimals,
  units, timestamps, identifiers and unsupported operations. Validate provider payloads
  inside the adapter before normalization.
- `run`: one provider interaction with injected credentials and transport, receiving
  trusted tenant context and a connection-scoped invocation.
- `descriptor`: contract version, minimum action risk, provider idempotency strategy and
  retry advice.

The capability runtime needs a tenant-scoped connection resolver that checks current
ownership and connection state on every call, plus an awaited evidence hook. It rejects
missing, mismatched and inactive connections, unsupported versions or capabilities,
invalid input/output and observations with mismatched provenance. Discovery returns
descriptors for the active connection only; the static provider catalog is neither
capability discovery nor authorization.

The in-memory sample connector in `@luma/connections` is a conformance fixture for
reads and conditional writes through API and browser mechanisms. It is not registered by
the server, and its deduplication lives only as long as its instance.

## Writes and verification

Write capabilities reach execution only as effect bindings. Each binding supplies
tenant-aware canonical-to-external mapping, parameter/target/evidence validation, fresh
precondition checks and authoritative read-only verification; invalid or unmapped intent
yields no adapter. Execution owns policy, approval, durable reservation, audit and
verification. Inject the low-level write port only into trusted execution adapters, never
into HTTP handlers or workflow activities.

- A write requires a nonempty idempotency key; holding the key is not authorization.
  Namespace provider keys by tenant and connection and bind them to immutable intent.
- `provider_key` means the provider deduplicates the key; `conditional_write` means an
  atomic precondition prevents unsafe replay; `none` promises neither.
- Capabilities that accept expected revisions must enforce them atomically with the
  effect. A preflight comparison that is not atomic (as for JTL shipping methods) must be
  documented and needs operationally controlled targets.
- A receipt means accepted. `verify` reads authoritative state, persists fresh
  observation evidence and checks the expected postcondition. It never writes.

Descriptor retry limits are advisory: execution reserves one attempt and never
redispatches it.

## Errors, retries and evidence

| Codes                                                          | Meaning / handling                                             |
| -------------------------------------------------------------- | -------------------------------------------------------------- |
| `unavailable`, `unsupported_capability`, `unsupported_version` | Resolve connection availability or select a supported contract |
| `invalid_input`, `invalid_response`                            | Fix input or adapter normalization; do not silently coerce     |
| `authentication`, `permission_denied`                          | Repair provider credentials or permissions                     |
| `not_found`, `conflict`                                        | Refresh mappings/state and reevaluate intent                   |
| `rate_limited`, `transient`, `timeout`                         | Follow explicit delay advice only when retry is safe           |
| `export_unavailable`                                           | History export cannot resume; request a new history import     |
| `internal`                                                     | Unclassified failure; inspect controlled operational evidence  |

Adapters throw `ConnectorError` with a normalized code, effect certainty (`none` or
`unknown`), retry advice and an optional delay. `none` means the adapter can establish
that no effect occurred. A timeout after a write is dispatched normally has an unknown
effect, and unknown effects always require reconciliation regardless of retry advice or
idempotency support. Unclassified exceptions and malformed write responses are unknown.
Provider exception text is discarded.

The Shopify, JTL and Cin7 transports make up to three attempts at a read that fails with no
effect and delay advice of at most two seconds. Shared admission deferral returns to the
caller or durable scheduler without a transport retry. Shopify retries only query documents;
writes and mutations are sent once. Longer advice and other failures reach the caller
unchanged.

The awaited evidence hook receives start, success and failure events with tenant,
connection, correlation, capability version, adapter version, mechanism and executor
provenance, but no inputs, outputs, credentials or raw exception text. A start-hook
failure prevents dispatch; a completion-hook failure propagates so execution keeps an
uncertain result. The hook supplements execution's durable audit; it does not replace it.
Raw capture must follow ADR-002 redaction and expiry rules.

## Import read patterns and measurements

Shopify nested page selections read parent records and their first child pages in one
query, and drain every child connection with `hasNextPage` before publishing an
observation. Root pages are capped at 25, or 5 for fulfillments and returns, to keep the
worst-case requested query cost below Shopify's single-query limit of 1,000. Full initial
history uses resumable Bulk Operations (see
[commerce sync](commerce-sync.md#recent-history-live-reads-and-exports)).

JTL ERP 2.2 uses `pageNumber`/`pageSize` with count metadata and publishes no maximum page
size or global request quota; do not treat simulator limits as provider guarantees.
Sales-order lines are an unpaged array, while delivery-note lines are separately paged.
There is no nested selection or batch read of complete orders, so child reads run at most
four at a time; keep concurrency bounded and honor 429/503 `Retry-After`. Orders support
`salesOrderDateAfter`, which is a creation filter, not an update filter.

Cin7 Core v2 pages lists with `Page`/`Limit` (at most 1,000) and a `Total`, allows 60
calls per minute per API application, and returns sales, credit notes and purchases
without lines, so each needs a detail read. Its stock report names locations and splits
products by bin and batch. See [Cin7](cin7.md#read-cost) for how the adapter paces and
groups these reads.

To compare read patterns, build the adapter and simulator packages and run
`node tooling/benchmarks/commerce.mjs`; `BENCHMARK_*` variables at the top of the script
select provider, records, page size, latency, capabilities, bulk mode and rate limiting.
It counts provider requests, pages, normalized records and elapsed time, validates every
page and rejects a query above the single-query cost limit. Results are adapter
measurements on synthetic data, without database projection time, real provider latency
or a throughput promise. Request reduction alone is not an end-to-end speedup claim.

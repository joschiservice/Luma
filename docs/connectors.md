# Connector capability SDK v0

The connectors module exposes typed capabilities through its public `index.ts`. Consumers select a connection and capability; adapters own provider mapping, credentials and API/browser interaction. The contract version is `0`. Normalized observation schemas use version `1`.

The [installed connection guide](installed-connections.md) covers tenant setup, encrypted credentials, health checks, rotation and permission-gated adapter composition.

## Capabilities

| Capability          | Input                                                            | Output                                         |
| ------------------- | ---------------------------------------------------------------- | ---------------------------------------------- |
| `orders.read`       | Page size and optional opaque cursor                             | Order lifecycle, payment summary and lines     |
| `orders.write`      | Order external ID, `cancel`, expected revision                   | Accepted write receipt                         |
| `inventory.read`    | Page query and optional SKU/location filters                     | Stock quantities, units and availability basis |
| `inventory.write`   | SKU, location, absolute available quantity and expected revision | Accepted write receipt                         |
| `fulfillment.read`  | Page query and optional order filter                             | Fulfillment lifecycle and line quantities      |
| `fulfillment.retry` | Fulfillment external ID and expected revision                    | Accepted write receipt                         |
| `products.read`     | Page query                                                       | Product status and SKU identities              |
| `customers.read`    | Page query                                                       | Customer profile within approved field groups  |

Handlers that list `filters: ['updatedSince']` in their descriptor accept `updatedSince` on page queries and return only records changed since then; others reject it. The first page of a scan may report `total`, the source's count of the whole collection (for progress only), and `history`, the earliest creation time the source shares with this connection and the permission that lifts the limit.

Each key selects its own `CapabilityInput<K>` and `CapabilityOutput<K>`. V0 order writes cancel an order; they do not create orders or edit arbitrary provider fields. Adapters advertise only operations they can implement with these semantics. Adding a different operation requires a contract change.

The [JTL-Wawi read adapter](jtl.md) implements all four read capabilities for on-premise and cloud connections with shared normalization and scoped evidence.

The [Shopify read adapter](shopify.md) implements all four read capabilities with scoped credentials, pagination, normalized evidence and webhook refresh hints.

Decimals are strings with at most fourteen integer and six fractional digits. Preserve negative/fractional inventory, unknown/null values and source revisions. Order-line `cancelledQuantity` is null when the source cannot distinguish cancellations from refunds or edits. External IDs remain opaque and case-sensitive. `scopeKey` is the parent namespace for local IDs, or an empty string for account-wide IDs. Tenant, connection, provider and resource complete the source identity. Canonical IDs are resolved explicitly through tenant-owned mappings; SKU text is not identity.

Read results contain observations and pagination metadata. `nextCursor` is opaque and bound to the connection and query. `completeness: complete` means the requested page is fully represented; only a successful scan of every page establishes collection completeness. A failed scan, filtered query or partial page cannot establish deletion. Tombstones are explicit. Each observation includes source identity, observation ID/time, source revision/time, adapter version and schema version. Persist observations with stable ingestion keys before canonical projection; never overwrite absent fields from a partial provider event.

Two additional JTL capabilities support shipping-method correction: `orders.shipping-method.read` reads one order's method with `{ order, limit: 1 }`; `orders.shipping-method.write` accepts the order, expected current method and replacement method. See the [JTL action guide](jtl.md#shipping-method-correction) for permission setup, verification and reversal.

## Implement an adapter

Implement a `ConnectorConnection` with current tenant/connection identity, state, provider, adapter version, executor provenance and a partial capability-handler map. Each handler supplies:

- `parseInput` and `parseOutput`: runtime validation of capability inputs and normalized outputs. Reject invalid decimals, units, timestamps, identifiers and unsupported operations. Validate provider payloads inside the adapter before normalization.
- `run`: one provider interaction using injected credentials and transport. It receives trusted tenant context and a connection-scoped invocation.
- `descriptor`: contract version, minimum action risk, provider idempotency strategy and retry advice.

`createSampleConnector` in `infrastructure/sample-provider.ts` demonstrates inventory reads and conditional writes with an in-memory provider. It supports a scoped idempotency key, rejects changed intent and stale revisions, and preserves null and fractional quantities. Its API/browser mechanism variants are conformance fixtures, not real integrations. Production provider credentials and transports belong in their infrastructure adapters; the sample is not registered by the server.

Wire `createCapabilityRuntime` in composition with a tenant-scoped connection resolver and an awaited evidence hook. The resolver must check current ownership and connection state on each call. The runtime rejects missing, mismatched and inactive connections, unsupported versions/capabilities, invalid input/output and observations with mismatched provenance. Discovery returns copies of descriptors for the active connection; the static public provider catalog is not capability discovery or authorization.

```ts
const result = await reader.read(context, {
  connectionId,
  capability: 'inventory.read',
  version: '0',
  input: { limit: 100 },
});
if (result.ok) {
  await ingest(result.value.items);
} else {
  await handleFailure(result.error);
}
```

Workflows receive `CapabilityReader` for discovery and reads. Orders/inventory ingestion remains behind their own module interfaces, following ADR-001. No domain rule inspects the provider or mechanism.

## Writes and verification

Supply `runtime.effects(binding)` as an `EffectRegistry` to the existing execution service. Each binding selects a write capability and supplies tenant-aware canonical-to-external mapping, parameter/target/evidence validation, fresh precondition checks and authoritative read-only verification. Invalid or unmapped intent returns no adapter. Compose registries in trusted composition when multiple write capabilities are enabled.

The bridge carries minimum risk and executor/mechanism provenance to execution. Execution owns policy, approval, durable reservation, audit and verification. Inject the low-level `write` port only into trusted execution adapters, never HTTP handlers or workflow activities. A write requires a nonempty idempotency key; possession of that key is not authorization. The SDK does not persist reservations or authorize direct writes.

Capabilities that accept expected revisions must enforce them atomically with the provider effect. The JTL shipping-method capability accepts an expected field value instead; its documented preflight comparison is not atomic and requires controlled order processing. Namespace provider keys by tenant and connection and bind them to immutable intent. `provider_key` means the provider deduplicates that key; `conditional_write` means an atomic precondition prevents unsafe replay; `none` promises neither. The sample deduplication is in-memory and survives only its instance.

A receipt means accepted, not verified success. `verify` must read authoritative state and persist fresh observation evidence, then check the proposal's expected postcondition. It must never write. The existing execution service handles verification freshness and ambiguous attempts. API and browser implementations satisfy the same handler and effect interfaces; mechanism metadata exists for audit and risk, not consumer branching.

## Errors, retries and evidence

| Codes                                                          | Meaning / handling                                             |
| -------------------------------------------------------------- | -------------------------------------------------------------- |
| `unavailable`, `unsupported_capability`, `unsupported_version` | Resolve connection availability or select a supported contract |
| `invalid_input`, `invalid_response`                            | Fix input or adapter normalization; do not silently coerce     |
| `authentication`, `permission_denied`                          | Repair provider credentials or permissions                     |
| `not_found`, `conflict`                                        | Refresh mappings/state and reevaluate intent                   |
| `rate_limited`, `transient`, `timeout`                         | Follow explicit delay advice only when retry is safe           |
| `internal`                                                     | Unclassified failure; inspect controlled operational evidence  |

Adapters throw `ConnectorError` with a normalized code, effect certainty (`none` or `unknown`), retry advice and optional delay in milliseconds. `none` means the adapter can establish that no effect occurred. A dispatched write timeout normally has an unknown effect. Unknown effects always require reconciliation, regardless of retry advice or idempotency support. Unclassified exceptions and malformed write responses are unknown; provider exception text is discarded. The Shopify and JTL transports repeat a read up to three times when it fails with no effect and a delay advice of at most two seconds (`retryRead` in `@luma/connector-core/transport`). Shopify repeats only documents that start with `query` or `{`; writes and mutations are sent once. Longer advice and other failures reach the caller unchanged. Descriptor limits remain advisory. Execution currently reserves one attempt and does not redispatch it.

The awaited `record` hook receives start/success/failure, tenant/connection, correlation, capability version, adapter version, mechanism and executor provenance. It excludes inputs, outputs, credentials and raw exception text. A start-hook failure prevents dispatch. A completion-hook failure propagates so execution retains an uncertain result. Hook events supplement the execution service's durable audit/outbox; they do not replace it. Production adapters persist tenant-scoped observations/raw-payload references through connector-owned storage and return their evidence IDs. Raw capture must follow ADR-002 redaction and expiry rules.

## Validation

`sample-provider.test.ts` tests both mechanism variants through one consumer, effect binding and verification, scoped discovery, invalid versions/input/output, idempotency conflicts, conditional writes, error normalization and evidence-hook failures. Identity authentication and database durability remain covered by their existing suites. Run `pnpm check` with `TEST_DATABASE_URL` set to PostgreSQL 17 to include those integration tests.

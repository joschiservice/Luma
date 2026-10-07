# Exception detection

`createDetectionServices(databaseUrl, now?, verifier?)` in `@luma/application-runtime` composes the exception repository and ingestion pipeline. Use the injected clock for reproducible replay. Call `close()` when the worker stops.

The pipeline evaluates the four [V0 taxonomy](exception-taxonomy.md) classes: sync failure, stuck fulfillment, inventory mismatch and workflow failure. It records every accepted evaluation with its rule version, configuration version, decision, evidence references and delivery correlation ID. Inventory evaluations also retain the exact signed difference, left minus right.

## Ingestion

All methods require an identity-resolved `TenantContext`. Workers must resolve current organization membership before calling them. These are internal application ports; there is no unauthenticated ingestion route. Scheduled detection (below) is the production caller for sync failures, stock mismatches and stuck fulfillment.

- `pipeline.inventory`: two normalized connector observations, explicit SKU/pool mappings, authority, completeness, projection currency and configuration. External IDs include their parent scope. Equal labels never establish a mapping. JTL aggregate stock requires an explicit equivalent Shopify pool mapping.
- `pipeline.fulfillment`: one normalized operation, explicit order/line mapping and current eligibility evidence. Resolve holds/schedules from trusted evidence; pass `unknown` when eligibility is unavailable. Split operations remain separate. Shipment quantities from mirrored systems are never summed.
- `pipeline.scan`: a durable scan event, connection/capability, normalized error and retry-window metadata. The ingestion job supplies `firstFailureAt`, resetting it after complete success. A single successful page must not set `scanComplete`. Include retry-after advice, latest failure time and last checkpoint in the event's normalized facts.
- `pipeline.workflow`: a durable worker event with stable run/step IDs, attempt, status, retry exhaustion and effect certainty. Unknown effects require an execution reference and reconciliation. This pipeline has no connector write port.

Keep observation and event keys stable on redelivery. Use a new key for a new authoritative poll. Keys identify immutable evidence within a tenant; namespace provider event IDs by connection. Store only normalized operational facts and provenance, never credentials, error text or customer payloads. Raw payload retention remains connector-owned.

`exceptions.ingest` is the normalized rule boundary for other trusted ingestion callers. It validates the supplied facts, evidence and configuration before persistence. `key` is a delivery correlation ID; changing it does not add an occurrence. Pass a new configuration version whenever a threshold changes. Reusing a version with different values fails atomically. Configuration selection belongs to the caller; the persisted version is the one used for that evaluation.

## Scheduled detection

The commerce sync process runs `createDetectionWorker` from `@luma/application-runtime` once a minute. For each workspace with an active sync it resolves the person the sync runs as through `detection_worker_scopes()`, then runs `createDetectionMonitor` from `@luma/resolution`. Stored state chooses candidates; fresh provider reads decide:

- **Sync failure:** every orders, fulfillment, product and stock stream with failed pages is evaluated with its first failure time (`failing_since`), latest error code and whether five attempts failed. The evidence key changes with each new failure, so repeated passes add no occurrences.
- **Stock mismatch:** stock positions that at least two connections report, because people linked their SKU and location, are compared when their stored availability differs. Each ERP report is paired with each storefront report; the app category decides which is which, and the ERP is the authority. Both sides are reread and projected before the rule runs, at most 25 positions per pass.
- **Stuck fulfillment:** open work in `orders_fulfillment_list` without progress for `stuckSeconds` is reread through its order. Reported holds, or a start time in the future, make the work exempt; work from an adapter that does not read holds stays unknown. At most 25 per pass, oldest progress first.

Open cases of these classes are always included. When the fresh evaluation is clear, the monitor requests verification. Its verifier rereads stock or fulfillment for the case's exact subject; a sync failure passes once its stream completes a scan after the latest detection without new failures. A case opened by a newly detected subject gets a diagnosis. Each rule runs independently, so an unavailable source does not stop the others, and failures are retried on the next pass.

A revoked or disconnected connection blocks its streams. The rule treats an inactive connection as clear, so connection health, not a case, reports it.

## Persistence and lifecycle

Migration `0003_exception_detection.sql` adds the `luma_exceptions` role. Grant it to the detection worker's restricted runtime login after running migrations with the migration owner. Every table has forced tenant RLS; runtime code cannot update or delete source evidence, configurations, inputs, evaluations or audit records.

A transaction stores source evidence and normalized inputs before creating/updating an incident. One advisory lock per tenant serializes evidence conflicts, fingerprint updates and resolution; unrelated tenants remain independent. A partial unique index guarantees one unresolved incident per fingerprint. This favors correctness for V0; throughput within a busy tenant is serialized.

Fingerprints use the taxonomy's SHA-256 material and stable source scope. An evidence set adds at most one occurrence per fingerprint, including concurrent redelivery. New evidence updates the active incident; failed and escalated incidents remain active. Resolved incidents are immutable. New evidence after resolution creates a successor linked to its predecessor; replaying old evidence cannot reopen it.

A clear or deferred decision never resolves an incident. Reevaluate deferred subjects after authoritative refreshes and while uncertainty remains. After 30 minutes with the default configuration, the next evaluation escalates an existing incident or records an operator review task in `exception_outbox`. No mismatch is invented. Successful certainty resets the uncertainty window.

State changes and append-only audit events commit together in `exception_outbox`. Audit delivery and worker scheduling are separate consumers; this change does not register a background dispatcher. `exceptions.list` and `exceptions.evidence` provide tenant-scoped reads for downstream diagnosis and inbox work. Detection never deletes or overwrites earlier connector snapshots.

## Resolution

`exceptions.resolve` accepts a context with `issues.manage`, an explicit human disposition, a reason and existing tenant evidence references. The record identifies the actor and is not counted as autonomous verified success. Caller-supplied verification results are rejected.

`exceptions.verify(context, incidentId)` requests verification from the `VerificationEvaluator` installed by the composition root. It fails closed when no evaluator is configured. The evaluator receives the tenant context and persisted incident, reads authoritative state, and checks the business postcondition. Neither evidence nor success flags come from the verification request.

Each evaluator evidence item must bind to the incident's class, canonical subject, rule identity and ordered scope. Its connection must match that scope. The required postconditions are `complete_scan_checkpoint_advanced`, `fulfillment_disposition_verified`, `equivalent_inventory_agrees` and `workflow_business_postcondition_verified`, respectively. The evaluator must establish these findings from source data; an accepted write receipt is insufficient.

Passed, complete, authoritative evidence must be independent of detection evidence, observed at or after the latest detection and within the configured freshness window. Failed, partial, stale or inconclusive results leave the incident open and return `false`. Mismatched evidence is rejected. A version check under the tenant lock rejects results if the incident changed while the evaluator was reading; external reads run outside the transaction.

Successful verification returns `true` and atomically persists resolution, evaluator version, evidence bindings and an audit reference. There is no repair or redispatch operation in detection.

## Validation

The production evaluator runs against every case in `docs/fixtures/exceptions-v0.json`. PostgreSQL integration tests exercise concurrent replay, conflicting evidence, tenant isolation, configuration versions, uncertainty, independent verification and recurrence. Real JTL and Shopify adapters normalize synthetic HTTP fixtures before the pipeline persists all four classes.

```sh
TEST_DATABASE_URL=postgresql://postgres:luma_test_only@127.0.0.1:55432/luma_test pnpm --filter @luma/api test
pnpm check
```

Use a disposable PostgreSQL 17 instance and an administrator URL for integration tests. The suite creates its own database and restricted runtime login. Without `TEST_DATABASE_URL`, database tests skip; CI supplies it.

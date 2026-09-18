# Exception diagnosis

The exceptions module produces versioned investigations from detection's immutable normalized evidence. `createDetectionServices` exposes `diagnoses.get`, `diagnoses.history` and `diagnoses.run`. The shared `diagnosisSchema` and `Diagnosis` DTO are exported by `@luma/api-contract` for the Exception Desk API and UI.

## Read and worker flow

1. Ingest through the detection pipeline. For an existing or newly detected incident, detection commits a pending diagnosis revision in the same transaction as its evaluation. Negative or uncertain evaluations without an incident create no diagnosis.
2. Return `diagnoses.get(context, exceptionId)` to serve pending state immediately. Reads never invoke connectors or the model gateway.
3. A worker calls `diagnoses.run(context, exceptionId)`. The engine assembles deterministic facts, constraints, possible causes, impact and next steps for all four taxonomy classes.
4. Read the persisted result. `history` retains earlier revisions with `superseded: true`. The worker cannot publish over a newer revision or a resolved incident.

The [durable runtime](exception-workflows.md) owns scheduling and authorization refresh. LUMA-32 owns HTTP routes; LUMA-21 consumes structured fields rather than interpreting prose. Apply migration `0005_exception_diagnosis.sql` with the normal migration command. Existing incidents acquire pending diagnoses on their next detection evaluation.

## Results and lifecycle

Statuses are `pending`, `ready`, `insufficient_evidence` and `failed`. A failed investigation retains established facts and a safe reason; it does not mean that the incident disappeared. A detector `clear` result requests lifecycle verification and never resolves an existing incident. Only the existing verification/disposition interfaces change that lifecycle.

Every finding references evidence retained with observation/source timestamps, source identity, adapter/schema versions and mapping versions. Configuration, taxonomy and engine versions are recorded separately. Raw connector payloads are neither read nor copied into diagnoses, so their expiry does not remove normalized provenance.

Observed outcomes and potential exposure are separate. Unknown quantities and costs remain null. For fresh JTL=4 and Shopify=12 observations of equivalent pools with JTL authority, the result records excess selling availability of `8.000000` and potential oversell exposure. It does not assert lost revenue, an oversold order or a synchronization failure. Fulfillment progress timestamps remain explicitly identified as proxies. Unknown workflow effects require reconciliation without redispatch.

V0 next steps are read/investigate or manual intervention. Current adapters do not support safe inventory writes, shipment retries or workflow redispatch, so this engine creates no executable candidate proposals. Future candidate coverage must reference the existing policies `ProposedAction`; it must not derive an executable intent from diagnosis prose. Attention is a rule-derived suggestion, never an approval or permission.

## Revisions and freshness

A revision key includes the immutable evidence set, configuration, engine version, detector outcome and uncertainty escalation state. Repeated processing does not duplicate recommendations. New relevant evidence/configuration creates a pending revision and supersedes the previous result. Previously processed evidence cannot replace the current revision, and observations older than the current evidence watermark do not advance it. A configuration change delivered with older observations reevaluates the newest retained evidence; restoring an earlier configuration creates a new investigation. Publication compares the revision under the detection lock.

Inventory and fulfillment recommendations expire with the oldest required observation. Reads expose expired results as insufficient and superseded, with no actionable next steps; detection must ingest current observations to produce a new revision. Historic facts remain available. Read failures can be retried on the same revision; persisted retry-after prevents early retries. Optional model failures preserve the deterministic result and are not retried on completed revisions.

## Scoped rereads

`createDiagnosisRereader` in workflows accepts only the existing `CapabilityReader`. Inject trusted `plan` and `publish` bindings for the canonical mapping and ingestion flow. Plans contain at most two read requests. Sync rereads use the incident's connection and capability without narrowing the complete scan to resource selectors. Inventory rereads require the mapped source SKU and stock pool; fulfillment rereads require the mapped source order. Missing or ambiguous mappings fail closed. Workflow effects use execution reconciliation, not connector rereads. The entire plan is validated before the first request. The publisher receives normalized pages, including completeness and cursors, and must publish through the detection pipeline. A partial page cannot establish a complete scan or absence.

The engine requests rereads for insufficient evidence and detected inventory mismatches when a rereader is configured. The bridge honors retained/provider backoff, performs no retry loop, and checks cancellation before another read or publication. The publisher receives the same abort signal and must honor it at the persistence boundary, including after asynchronous preparation, so an expired investigation cannot commit its publication. A five-second deadline bounds each read phase; current connector calls may finish after cancellation, but their results are not published by the bridge. The worker receives any newly published revision as pending and schedules its evaluation. Without a read binding, the result records unavailable rereads and requests manual investigation.

## Optional model reasoning

Inject an existing Model Gateway and profile through `DiagnosisOptions.model`. Tenant data always requests sensitive/EU/zero-retention routing; an unavailable or denied EU route leaves deterministic findings intact. There are no tools, raw payloads, credentials or arbitrary provider errors in model inputs/results. Requests contain only normalized findings and a finite list of unsubstantiated hypothesis codes/checks, with a five-second deadline and 512 output-token limit.

The model can prioritize supplied hypotheses. It cannot add free-form claims, new evidence, actions, approval state or verification. Strict schema validation rejects extra fields, duplicate/unknown hypotheses, invented evidence IDs and tool calls. Model and prompt versions are recorded only for accepted output; unavailable/rejected reasoning remains visible as safe provenance.

## Validation

`pnpm test` runs every versioned taxonomy case through diagnosis, plus exact exposure, uncertainty, escalation and deadline checks. With `TEST_DATABASE_URL`, PostgreSQL tests cover pending/publication, deduplication, tenant RLS, configuration invalidation, stale workers, source provenance, freshness, recoverable reads and injected model failures. Workflow read tests cover scope, partial pages, limits, cancellation and retry-after. Run `pnpm check` and `pnpm test:e2e` before review.

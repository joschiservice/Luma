# Resolution learning

Resolution runs keep the structured, append-only history of how an incident was handled:
the selected resolution artifact, cause assessments, human and automated repair steps,
verification attempts, outcome and recurrence. A learning record grants no execution
authority, and an operator's claim of success never substitutes for persisted
verification. `@luma/resolution` owns runs and events; every operation requires a freshly
refreshed context with `issues.manage`.

## Runs and events

A run is started for an incident with a client-chosen UUID, the diagnosis revision and a
resolution selection; operator facts are appended to it as events, each with its own UUID
and `occurredAt` (see the OpenAPI schema for the fact types). Lists page 50 runs at a time.

- New runs need a published diagnosis and an active resolution artifact. Existing admitted
  runs can still be annotated after the artifact is revoked. Incident, diagnosis and
  artifact bindings must agree.
- Automated steps bind with the same run ID. Human and automated steps cannot share a
  run/step identity.
- The API derives actor and recording time from the request. Exact retries return the
  original record and conflicting IDs return 409. Records are never edited or deleted;
  corrections are new events.
- Selection `use` (`created`, `improved`, `reused`, `partner_specific`) is an operator
  assessment. `improved` needs an existing, different `previousVersion`; `partner_specific`
  needs a `partnerCodeRef`. The artifact's digest and generation reference are captured
  automatically.

## Recording rules

- Diagnosis hypotheses keep their original origin and unsubstantiated status. Confirming
  or rejecting a cause requires investigator attribution and the corresponding evidence; a
  model hypothesis can never confirm a cause.
- Ingest evidence before referencing it. References must belong to the incident,
  including retained diagnosis revisions, or to its persisted verification evidence. Store
  human input bindings and edit content as protected evidence and reference them by ID and
  hash.
- Codes never contain customer payloads, credentials or provider error messages.
- Effort is in seconds. Intervention effort is additional to repair effort, not a copy, and
  a repair's effort cannot exceed its elapsed time.
- An operator's `verified` outcome must match the incident's persisted, complete,
  authoritative verification and evaluator version. API acceptance or a passed action check
  does not prove resolution.
- Recurrence is both exported from canonical incident links and recordable as an explicit
  operator observation.

## Verification records

Execution persists a pending record before every authoritative read and a separate
completion with the result or a normalized failure. Reconciliation adds records, including
observations from concurrent calls that lost the execution-state update. A crash leaves an
unmatched pending record. Dispatch failures keep safe codes, retry and effect metadata and
provider request IDs when available, never provider messages.

Incident verification records its own pending and completed attempts, including validation
failures. A completed evaluation keeps the evaluator result and `accepted`, which says
whether persistence resolved the incident; persistence errors also record
`resolution_rejected` without the message. After a crash before completion, the exported
canonical resolution shows whether resolution committed. Pending, failed and inconclusive
records stay available after later success.

## Storage and export

Run and event rows use tenant-scoped keys, foreign keys, forced RLS and insert/read-only
grants. Writes serialize per run, and command IDs deduplicate retries. Acceptance runs in
the same transaction as the run lock, source reads, sequence allocation and insert; a
rejection rolls back the command.

A run references the retained `(tenant, incident, diagnosis revision)` snapshot and
captures its evidence IDs, mapping, configuration, rule and diagnosis versions, original
hypotheses and model provenance; a run against an older diagnosis captures that revision.
Raw evidence stays in its owner's tables: execution owns action verifications and failures,
and exceptions records incident verification attempts in its outbox.

The export is an owned read projection across those tables and admission records, read in
one PostgreSQL statement snapshot so its collections are consistent. It contains the
selection and context, ordered operator facts, automated bound inputs and hashes, execution
records, every action and incident verification attempt, the current canonical resolution
and recurrence IDs. Histories before this feature are not backfilled. Exports are tenant
data and must be de-identified before reuse as fixtures.

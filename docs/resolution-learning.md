# Resolution learning

Resolution runs preserve the structured history of an incident. Owners and admins
can record a selection, append operator observations and export the full chain.
No new execution authority is granted by a learning record.

## Record a run

1. Publish the incident's diagnosis and activate a versioned resolution artifact
   through the existing trusted provisioning service.
2. POST to `/v1/organizations/:organizationId/exceptions/:exceptionId/resolution-runs`
   with a UUID `id`, `diagnosisRevision` and `resolution`:

   ```json
   {
     "id": "0bc153e7-bafc-4c97-b265-1b6a70bd364d",
     "diagnosisRevision": 1,
     "resolution": {
       "id": "inventory-repair",
       "version": "2",
       "use": "improved",
       "previousVersion": "1",
       "reasonCode": "correct_mapping"
     }
   }
   ```

3. Use that same run ID when binding automated steps. Existing admitted runs can
   also be annotated after artifact revocation. Incident, diagnosis and artifact
   bindings must agree. New runs require an active artifact.
4. POST operator records to `.../resolution-runs/:runId/events`. Each request has
   a unique UUID `id`, `occurredAt` and a discriminated `fact` (see OpenAPI).
5. GET `.../resolution-runs` to find runs. Pages contain up to 50 records; pass
   `nextCursor` as `after`. GET `.../resolution-runs/:runId` to export one run.

The API derives actor and recording time from the authenticated request. Exact
retries return the original record. Conflicting IDs return 409. Corrections use a
new event; records cannot be edited or deleted by runtime database roles.

## Structured records

| Fact           | Captured data                                                                                                                           |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `cause`        | Cause code, suspected/confirmed/rejected status, supporting and contradicting evidence, investigation basis                             |
| `repair_step`  | Stable step ID, action code, bound input evidence references, action hash, start/end, effort seconds, acceptance/failure/unknown result |
| `intervention` | Existing step ID, reason, evidence and additional operator effort                                                                       |
| `observation`  | Existing step ID, observation code and evidence                                                                                         |
| `human_edit`   | Existing step ID, before/after hashes, reason and evidence of the edit                                                                  |
| `outcome`      | Pending/failed/inconclusive/verified result, evaluator version, authoritative/complete flags, evidence and measured business result     |
| `recurrence`   | A subsequent incident whose canonical previous-incident link identifies this case                                                       |

Selection `use` distinguishes `created`, `improved`, `reused` and
`partner_specific`. This is an operator assessment. Improvements require an
existing, different `previousVersion`; partner-specific work requires a
`partnerCodeRef`. The selected artifact's digest and generation reference are
captured automatically. Diagnosis hypotheses retain their original origin and
unsubstantiated status. Confirmed/rejected cause assessments require investigator
attribution and the corresponding evidence; a model hypothesis cannot confirm a
cause.

Ingest supporting evidence before referencing it. References must belong to the
incident, including retained diagnosis revisions, or its persisted verification
evidence. Store human input bindings and
edit content as protected evidence, then reference them by ID and hash. Do not
put customer payloads, credentials or provider error messages into codes. Effort
is in seconds; intervention effort is additional to repair effort, not a second
copy. A repair's effort cannot exceed its elapsed time.

## Verification and delayed evaluation

Execution persists a pending record before every authoritative read and a separate
completion with the result or normalized failure. Reconciliation adds records,
including observations from concurrent calls that lose the execution-state
update. Crashes leave an unmatched pending record. Dispatch failures retain safe
codes, retry/effect metadata and provider request IDs when available. Provider
messages are not retained.

Incident verification records its own pending/completed attempts, including
validation failures. Completed evaluations preserve the evaluator result and
`accepted`, indicating whether persistence resolved the incident. Persistence
errors also record `resolution_rejected`, without retaining error messages. A crash
before completion leaves a pending attempt; consult the exported canonical
incident resolution to determine whether resolution committed.

API acceptance and a passed action check do not prove the incident is resolved.
An operator's `verified` outcome must match the incident's persisted, complete,
authoritative verification and evaluator version. Pending, failed and inconclusive
records remain available after later success. Recurrence links are both exportable
from canonical incidents and recordable as explicit operator observations.

## Storage and reconstruction

Workflows owns `resolution_runs` and `resolution_learning_events`. Their
PostgreSQL rows use tenant-scoped keys, foreign keys, RLS and insert/read grants.
Run/event writes serialize per run; command IDs deduplicate retries. Human and
automated steps cannot share the same run/step identity.

The run references the retained `(tenant, incident, diagnosis revision)` snapshot
and captures its evidence IDs, mapping/config/rule/diagnosis versions, original
hypotheses and model provenance. Raw evidence stays in the source owner's tables.
Execution owns `execution_verifications` and `execution_failures`; exceptions
records verification attempts in its append-only outbox.

The workflow export is an explicitly owned read projection across these owner
tables and existing admission records. It uses one PostgreSQL statement snapshot
for consistent collections. It includes immutable selection/context, ordered
operator facts, automated bound inputs and hashes, execution records, all action
and incident verification attempts, current canonical resolution and recurrence
IDs. Raw source payloads are not copied into learning tables. Authenticated
exports remain tenant data and must be de-identified before reuse as fixtures.

Apply migrations `0014_execution_observations.sql` and
`0015_resolution_learning.sql` with the standard migration command. Existing
histories are not fabricated or backfilled; attempts are captured from deployment
onward. A run created against an older diagnosis captures that retained revision.

The PostgreSQL integration fixture reconstructs a synthetic incident through cause
assessment, human repair/edit/intervention, an admitted action, delayed failed and
inconclusive reads, authoritative resolution and recurrence. It also checks
replay, concurrent commands, RLS, authorization and append-only permissions. A
production incident can be recorded through the same endpoints; no partner data
is included in the fixture.

## Command implementation and tests

The learning command module owns selection acceptance, event acceptance and record
construction. Its domain rules compare validated commands with retained facts. Transport
schemas continue to validate command shape, cause assertions and repair chronology.

The atomic storage adapter checks exact retries before invoking acceptance. PostgreSQL
keeps the existing run and event locks, JSONB request comparison, source reads, sequence
allocation and insertion in one transaction. Rejection rolls back the command. Automated
binding triggers continue to use the same run lock. Source reads retain their existing
isolation; only the history export promises one statement snapshot for all collections.

`resolution-learning.test.ts` exercises the public commands with production validation
and an in-memory adapter. PostgreSQL integration tests remain responsible for concurrency,
retry matching across runs, rollback, tenant isolation and append-only storage permissions.

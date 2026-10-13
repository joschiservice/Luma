# Exception diagnosis

Diagnosis turns detection's immutable normalized evidence into a versioned investigation:
facts, constraints, possible causes, impact and next steps for each taxonomy class. Every
finding cites retained evidence, and a diagnosis never changes the incident lifecycle or
grants execution. `@luma/exceptions` owns the engine and persistence; the
[durable workflow](exception-workflows.md) schedules runs and refreshes authorization.

## Flow and status

Detection commits a pending diagnosis revision in the same transaction as the evaluation
for an existing or newly detected incident. Negative or uncertain evaluations without an
incident create none. Reads return the persisted state immediately and never call
connectors or the model gateway. A worker runs the engine and publishes the result;
earlier revisions stay in history as superseded. A worker cannot publish over a newer
revision or a resolved incident.

Statuses are `pending`, `ready`, `insufficient_evidence` and `failed`. A failed
investigation keeps established facts and a safe reason; it does not mean the incident is
gone. A detector `clear` requests lifecycle verification and never resolves an incident;
only verification or a human disposition changes the lifecycle.

## Findings

Findings reference evidence with observation and source timestamps, source identity,
adapter, schema and mapping versions. Configuration, taxonomy and engine versions are
recorded separately. Raw connector payloads are neither read nor copied, so their expiry
leaves provenance intact.

Observed outcomes and potential exposure stay separate, and unknown quantities and costs
stay null. For fresh JTL=4 and Shopify=12 observations of equivalent pools with JTL
authority, the result records excess selling availability of `8.000000` and potential
oversell exposure; it does not assert lost revenue, an oversold order or a sync failure.
Fulfillment progress timestamps stay labeled as proxies. Unknown workflow effects require
reconciliation without redispatch.

Next steps are read/investigate or manual intervention. Diagnosis creates no executable
proposals: executable actions come from proposal producers and case workflows as
policies `ProposedAction` values, never from diagnosis prose. Attention is a rule-derived
suggestion, never an approval or permission.

## Revisions and freshness

A revision key covers the immutable evidence set, configuration, engine version, detector
outcome and uncertainty escalation state, so repeated processing never duplicates
recommendations. New relevant evidence or configuration creates a pending revision that
supersedes the previous one. Already processed evidence cannot replace the current
revision, and observations older than the current evidence watermark do not advance it. A
configuration change delivered with older observations reevaluates the newest retained
evidence; restoring an earlier configuration creates a new investigation. Publication
compares the revision under the detection lock.

Inventory and fulfillment recommendations expire with their oldest required observation.
Workspace inventory authority is rechecked on diagnosis reads. A changed override revision
or source selection marks the result insufficient and superseded, with no next steps;
the stored diagnosis and evidence stay intact.

Expired results read as insufficient and superseded, with no actionable next steps, until
detection ingests current observations; historic facts stay readable. Read failures retry
on the same revision, and a persisted retry-after prevents early retries. Optional model
failures keep the deterministic result and are not retried on completed revisions.

## Scoped rereads

The engine requests rereads for insufficient evidence and supported detected inventory, sync and fulfillment issues
when a rereader is configured; without one, the result records rereads as unavailable and
asks for manual investigation. The rereader in `@luma/resolution` uses only the existing
`CapabilityReader`, with trusted bindings that plan reads from canonical mappings and
publish through the detection pipeline.

The default-off `active-diagnosis` release installs those bindings in the application and
scheduled detection worker. Investigations require current `issues.manage` access and the
installed connection owner's read authorization; support views cannot investigate. Permission,
tenant, release and source authority are rechecked before publication. Superseded or resolved
investigations cannot publish over the current diagnosis.

- A plan holds at most two reads and is validated in full before the first request.
- Each incident has one database-backed investigation lease and a retained 15-minute cooldown.
  Provider retry-after can extend the cooldown. Point reads request ten records; a sync experiment
  requests one hundred. The normalized response budget is 256 KiB. These are capability-call
  limits; connector retry policies may make several transport attempts within a call.
- Sync rereads use the incident's connection and capability and never narrow the complete
  scan to resource selectors. Inventory needs the mapped source SKU and stock pool;
  fulfillment needs the mapped source order. Missing or ambiguous mappings fail closed.
- Workflow effects use execution reconciliation, not connector rereads.
- The publisher receives normalized pages with completeness and cursors. A partial page
  cannot establish a complete scan or absence.
- Normalized observations, their owner projections and detection ingestion share one transaction.
  Inventory freshness is claimed only when both reads project to the same current mapped position.
  Native-owned allocations cannot be treated as equivalent provider stock pools. Fulfillment
  rereads leave hold/schedule eligibility unknown rather than reusing an expired eligibility claim.
  A sync experiment does not advance the sync owner's checkpoint.
- Retained and provider backoff are honored, with no retry loop. Cancellation is checked
  before each read and publication, and the publisher must honor the abort signal at the
  persistence boundary, so an expired investigation cannot commit. A five-second deadline
  bounds each read phase; a connector call can finish after cancellation, but its result
  is not published.

A newly published revision reaches the worker as pending and is evaluated in turn.
The retained experiment prevents that revision from immediately rereading itself. Complete
passive findings stay usable while optional rereads are on cooldown; insufficient evidence stays
failed with backoff. Successful experiments retain source timestamps, supporting observations,
contradictions to persistent-read or snapshot-only explanations, remaining causal checks, actor,
call budget and unknown read cost. They establish neither historical cause nor resolution, and
grant no consequential write authority. Real incident volume and measured diagnosis benefit are
required before production release.

## Optional model reasoning

An injected Model Gateway profile may prioritize hypotheses. Tenant data always requests
sensitive, EU, zero-retention routing; if that route is unavailable or denied, the
deterministic findings stand. Requests contain only normalized findings and a finite list
of unsubstantiated hypothesis codes and checks: no tools, raw payloads, credentials or
provider errors. Each call has a five-second deadline and a 512 output-token limit.

The model can only reorder supplied hypotheses. It cannot add claims, evidence, actions,
approval state or verification. Strict validation rejects extra fields, duplicate or
unknown hypotheses, invented evidence IDs and tool calls. Model and prompt versions are
recorded only for accepted output; unavailable or rejected reasoning stays visible as safe
provenance.

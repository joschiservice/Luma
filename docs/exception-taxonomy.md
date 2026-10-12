# V0 exception taxonomy and golden cases

Version: `v0.2`. Owner: `@luma/exceptions`.

This spec defines four exception classes, using the names and lifecycle in
[ADR-002](architecture/002-canonical-commerce-model.md): what evidence each needs, when it
fires, how it may be resolved and what verifies it. Rules consume normalized evidence,
never provider payloads. The [golden cases](../packages/exceptions/fixtures/exceptions-v0.json)
are synthetic acceptance vectors for every rule decision; the production evaluator must
reproduce each expected result. [Detection](exception-detection.md) persists and
deduplicates the decisions.

## Evidence assumptions

Frequency, commercial impact and all thresholds below are hypotheses, not validated
customer findings. Recalibrate them in a new rule version and keep the current vectors for
regression comparison. The rules rest on these provider facts:

- Shopify webhooks can arrive out of order or be missed
  ([guidance](https://shopify.dev/docs/apps/build/webhooks)). Missing webhooks alone never
  prove a sync failure; preserve ordering and reread.
- Shopify fulfillment work can be scheduled, held, processing, incomplete or closed
  ([states](https://shopify.dev/docs/api/admin-graphql/2026-07/enums/FulfillmentOrderStatus)).
  Pending work is not automatically stuck; a closed work item is not shipment proof.
- Inventory has distinct quantities per location
  ([quantities](https://shopify.dev/docs/apps/build/orders-fulfillment/inventory-management-apps/manage-quantities-states)).
  Compare available stock only across equivalent units and mapped stock pools.
- [JTL](jtl.md) and [Shopify](shopify.md) adapters preserve negative and fractional
  quantities, split operations, unknown fields and read failures. Never infer missing JTL
  operations, or write support from read support.
- JTL-Worker sync jobs run on configured intervals and need a running worker
  ([configuration](https://guide.jtl-software.com/jtl-wawi/jtl-worker/jtl-worker-einrichten-und-konfigurieren/)).
  Check job evidence and configuration before attributing lag to a failed worker.
- Temporal activities retry ([execution](https://docs.temporal.io/activity-execution)). A
  worker failure does not prove that an effect did not occur, and retry advice never
  authorizes replaying an ambiguous write ([execution recovery](execution.md)).

## Shared evaluation contract

- Evaluate with an injected UTC `now`; fixtures never use the machine clock. Rules use
  elapsed time, not business hours.
- Read trusted tenant context and explicit source-to-canonical mappings. Equal SKU labels,
  order numbers or external IDs never establish identity. Reject cross-tenant evidence
  before evaluation.
- Every decision records rule and configuration versions, subject, source/connection scope
  and immutable evidence references. Evidence includes observation/event IDs, observed and
  source times, adapter/schema versions and normalized facts, and must stay interpretable
  after raw payloads expire. Keep secrets and customer payloads out of facts.
- `detect` creates or updates an incident. `clear` means the rule did not fire; it is
  **not** permission to resolve an existing incident. `defer` means evidence is
  insufficient and requests a reread or mapping review; it never authorizes writes.
  `reject` means invalid tenant provenance. If uncertainty lasts 30 minutes from the first
  deferred evaluation, escalate the existing incident or emit an operator review task; never
  invent a mismatch.
- Fresh means `0 <= now - observedAt <= 300 s`. Future observations are uncertain.
  Inventory pairs also require observation skew `<= 60 s`. Fresh authoritative polls can
  have a null source-update time (JTL inventory); source-update time is not the freshness
  clock. Reread out-of-order or ambiguous projections before evaluation.
- Thresholds are fixture defaults, not service promises: freshness 300 s, pair skew 60 s,
  sync retry window 900 s, stuck progress 7,200 s, uncertainty escalation 1,800 s,
  inventory tolerance `0`, sync propagation 1,800 s and oversell guard 25 %. Tenant configuration is versioned; changing a value requires
  reevaluation and invalidates stale proposals.
- Use exact decimal arithmetic (up to 14 integer and 6 fractional digits). Null is
  unknown, zero is known, and negative or fractional stock is valid. Never derive available
  stock from on-hand minus reserved.
- Malformed facts fail validation before evaluation; invalid numbers or timestamps never
  become healthy outcomes.

### Evaluation order

After schema validation, reject tenant mismatches first. Within each class, the first
applicable branch wins:

1. **Sync:** access lost → inactive → successful complete scan → successful incomplete
   scan (defer) → hard error → transient error window → unclassified error. Future
   failure-window timestamps defer.
2. **Fulfillment:** missing mappings/completeness or stale/future observation → unknown
   status → terminal status → unknown/negative quantity or unknown unit → zero quantity →
   explicit failure → exempt eligibility → unknown eligibility → null/future progress →
   age threshold. Failure detection needs no progress timestamp. The caller resolves
   eligibility from current exemption evidence; a bare pending status is insufficient.
3. **Inventory:** missing SKU/pool mapping → incomplete/ambiguous projection → null
   quantities → unknown/different units → non-provider basis → future/stale observations
   → pair skew → tolerance → pending sync → severity. Oversell severity requires the
   selling source and the authority to be different sources.
4. **Workflow:** missing durable evidence → unknown effect → intentional cancellation →
   healthy running/succeeded → exhausted failed/timed-out step → pending retry. An
   interrupted step with known no effect defers for a durable terminal or retry decision.
   Unknown effects take precedence over cancellation or reported success.

### Identity, repetition and overlap

Fingerprint material is the canonical JSON array
`["v0", class, ruleIdentity, subjectKind, subjectId, scope]`, hashed with SHA-256 within
the tenant. Rule identities are stable across threshold and version edits. `scope` is an
ordered array defined per class and never contains timestamps, quantities, error text or
attempt numbers. Source pairs use lexicographically sorted connection IDs.

Deduplicate immutable evidence keys before counting. A repeated delivery adds no
occurrence; new evidence for an active fingerprint adds one and updates the last-detected
time. Reusing an evidence key with different facts is rejected. Failed and escalated
incidents remain active. A resolved fingerprint produces a new incident linked to its
predecessor. A rule version change alone does not split an incident.

If a connector failure causes a workflow failure, keep both subjects and link causation;
do not merge fingerprints. Stale inventory caused by a sync failure yields `defer`, not a
second stock incident. Never sum mirrored JTL and Shopify shipments. Approval and execution
records stay separate from detection.

## 1. `sync_failure`

**Subject:** a JTL or Shopify connection, its read capability and ingestion job. Subject
`connection`; rule identity `connection-read`; scope `[capability]`.

**Normal:** a successful, complete scan of the requested scope advances its checkpoint.
Quiet webhook traffic and an idle worker are normal without a scheduled job failure.

**Trigger:** an active connection has a normalized failed read. `authentication`,
`permission_denied`, `invalid_response`, `unsupported_capability` and `unsupported_version`
detect immediately (`high`). `transient`, `timeout` and `rate_limited` detect (`medium`)
only when `retryExhausted = true` and at least 900 s have passed since `firstFailureAt`.
A success resets the window. Other errors defer for classification. A failed pagination
page is a read failure; keep every last-good snapshot. A connection the provider stopped
accepting (`accessLost`: Luma recorded a credential or grant rejection and nobody
reconnected since) detects immediately (`high`, reason `access_lost`) even though its
streams no longer read. Connections a person disconnected are excluded.

**Evidence:** connection, capability, failed scan/event ID, normalized error code, first
and latest failure time, retry exhaustion, retry-after advice and last successful
checkpoint. Never parse error messages. Failed or incomplete scans never prove deletion.

**Likely causes:** revoked credentials, missing grants or licence, provider outage,
throttling, schema change or broken pagination. These are diagnosis candidates, not facts
inferred from an error.

**Safe resolution:** a read-only refresh after retry-after or backoff; credential or grant
repair by an authorized operator; adapter correction for invalid responses. Never retry
authorization errors repeatedly. Luma has no automatic credential or grant mutation; any
future side-effecting repair goes through execution policy.

**Verification:** a new complete successful scan of the same capability and scope, after
repair, advances the checkpoint with persisted evidence. One successful page or receipt is
insufficient, and authentication success without a completed scan does not resolve a
data-sync incident.

**Escalate:** immediately for hard errors; when a transient failure persists 30 minutes
after detection; with no authorized credential owner; on repeated invalid responses; when
a related write has an unknown effect.

## 2. `stuck_fulfillment`

**Subject:** a normalized JTL delivery note or Shopify fulfillment operation with its
order/line mapping. Subject `fulfillment`; rule identity `fulfillment-progress`; scope
`[connectionId]`. Split operations keep separate identities.

**Normal:** positive work progresses within 7,200 s; shipped, delivered and cancelled work
is terminal. Scheduled or held work is excluded while a current, trusted exemption is in
force. An expired exemption resumes evaluation against the recorded progress time.

**Trigger:** with fresh, mapped, complete operation evidence and a known positive line
quantity, `failed` detects immediately (`high`), and `pending`/`processing` with
`now - lastProgressAt >= 7,200 s` detects (`medium`). A null or future progress time,
unknown status, quantity or unit, or unresolved hold/schedule eligibility defers. Zero
remaining quantity is clear. A partial shipment does not clear another operation's
outstanding work.

**Evidence:** operation, order and line references, quantities, current status,
observation time, last progress and its basis, and any exemption evidence. Progress times
are proxies: Shopify `updatedAt` also changes on unrelated edits, and JTL uses note creation
or latest package shipping time (no note means no observable operation). Record that basis
rather than claiming warehouse inactivity.

**Likely causes:** stock shortage, incomplete address or carrier data, warehouse backlog,
connector failure or rejected provider processing. Diagnose with scoped evidence; keep
personal data out of exception facts.

**Safe resolution:** reread the operation and order and ask the warehouse owner to
inspect. Shipment-affecting actions are high risk: someone else with `decisions.respond`
approves the immutable intent, and the action must recheck current state, remaining work
and target identity before dispatch. Available actions are
[Shopify fulfillment recovery](shopify-actions.md#fulfillment-recovery) (release a hold, reopen,
move remaining items) and the [JTL shipping-method correction](jtl.md#shipping-method-correction)
for a diagnosed incorrect method; the latter's verification proves only the method change.
Adapters that do not read holds or schedules leave eligibility unknown, so pending work
defers.

**Verification:** fresh operation and shipment evidence proves the intended line
quantities shipped or delivered, or a reviewed cancellation disposition exists. Progress
alone can remove the age trigger but never proves fulfillment. A tracking label, a closed
Shopify work item or an accepted write is not shipment proof.

**Escalate:** immediately for explicit failure, missing approval or capability, or an
ambiguous shipment; after another 7,200 s without progress following detection; when
eligibility stays unresolved past the uncertainty window. Never retry shipment effects
with unknown outcomes.

## 3. `inventory_mismatch`

**Subject:** JTL and Shopify inventory snapshots for an explicitly mapped SKU and
equivalent stock pool. Subject `sku`; rule identity `available-stock`; scope
`[canonicalLocationId, ...sortedConnectionIds]`.

**Normal:** comparable, fresh available quantities differ by at most the tolerance.
`abs(left - right) > tolerance` triggers; with the default zero tolerance any exact
difference qualifies.

**Trigger:** both available values are known and provider-reported, units are known and
equal, mappings establish the same SKU and pool, evidence is complete and current, and
freshness and skew pass. A difference above tolerance detects `medium`. When a configured
authority exists and the selling source reports more available than the authority, detect
`high` with reason `oversell_risk`: exposure, not proof of an oversold order. Without an
authority the mismatch is still detected, but no correction direction exists. Equal
negative stock is not a mismatch.

**Pending sync:** a sale changes one provider before the stock sync reaches the other, so
most gaps close on their own within minutes. The detector records when Luma first saw the
gap: the first stored report after the last report on which both sides agreed. A gap first
seen at most 1,800 s ago defers with `propagation_pending`, except when the selling source
shows stock while the authority has none left, or exceeds the authority by more than the
oversell guard, a percentage of the authority's available stock. Those gaps detect at once.
The default window covers a sale that needs two sync cycles of up to 15 minutes, one to
import the order and one to push the new stock. The default guard lets small overstatements
wait, because the storefront would have to sell through the authority's whole stock before
the sync arrives, while low stock still detects at once. Luma reads agreeing positions mostly during sync, so the
last agreement can be hours old; agreement older than 24 hours does not count and the gap
is evaluated without waiting. Without agreement history the rule never waits. Because the
age counts from the first report that disagreed, a gap that keeps changing still detects
once it outlasts the window. Verification uses the same rule, so it is inconclusive while a
gap is pending. Waiting is not uncertainty: it resets the uncertainty window instead of
escalating, because the rule itself detects once the wait ends. The detector stores the
current wait per fingerprint so views can show the gap as syncing until it closes or is
raised.

**Evidence:** both source identities and observations, canonical mappings and their
version, available quantities, units and basis, observation and source-update times,
authority version, tolerance, the exact signed difference and the agreement history
searched with the two agreeing reports. JTL `all-warehouses` cannot
match one Shopify location without an explicit stock-pool aggregation mapping. Warehouse
on-hand never substitutes for available stock.

**Likely causes:** lagged sync, differing pool configuration, reservations, manual edits,
mapping errors or provider-specific allocation. Establish authority and stock semantics
before choosing a correction.

**Safe resolution:** authoritative rereads first. A correction writes an absolute value
from the configured authority, requires fresh source and target evidence and a guard
against concurrent change, and is high risk, needing approval by someone else with
`decisions.respond`. The available route is the
[Shopify inventory correction](shopify-actions.md#inventory-corrections), which sets Shopify from a
JTL authority; Luma never writes ERP stock. Never use a new proposal to replay an
uncertain write.

**Verification:** after correction, reread both equivalent pools; fresh complete values
agree within tolerance and the approved postcondition holds under the same mappings and
authority. Accepted writes and old snapshots cannot resolve the incident.

**Escalate:** immediately for oversell risk, ambiguous authority or unsafe write support;
when uncertainty persists 30 minutes; when the mismatch remains 30 minutes after
detection; when verification fails or a write outcome is unknown.

## 4. `workflow_failure`

**Subject:** a durable workflow or worker execution and any linked connector action.
Subject `workflow_run`; rule identity `workflow-step`; scope `[stepKey]`.

**Normal:** running, successful or intentionally cancelled work, and scheduled retries
within budget. A missing heartbeat alone is insufficient without a durable timeout or
failure event.

**Trigger:** a durable terminal `failed`/`timed_out` step with exhausted retries detects
`high`. An execution interrupted with a durable prepared, running or unknown effect also
detects `high`, reason `reconciliation_required`, even when retries remain. The stable
run/step identity is used; a new attempt number never creates another incident. A
nonterminal failure without an unknown effect is clear while retries remain. Missing
durable evidence defers.

**Evidence:** failure event ID and time, run UUID, step key, attempt, normalized code,
terminal status, retry budget and linked execution/attempt IDs with effect certainty.
Never infer workflow state from raw worker logs.

**Likely causes:** exhausted external retries, invalid input, deployment crash,
unavailable dependency or lost completion persistence. A worker crash does not prove the
external effect failed.

**Safe resolution:** inspect and reread first. Unknown effects go to read-only execution
reconciliation and are never redispatched. A known-no-effect retry must keep logical
idempotency and recheck intent, policy and business preconditions; medium- and high-risk
effects need independent approval by someone with `decisions.respond`. Execution has no
redispatch protocol today.

**Verification:** a durable successful step plus fresh evidence of its business
postcondition, with linked execution verification where effects exist. A restarted
worker or an accepted activity is not recovery proof. Reconciliation with passed
verification can close the incident; unrelated later runs cannot.

**Escalate:** immediately for unknown effects without conclusive reconciliation,
exhausted retries or missing capability; to an operator for code or configuration
changes. Keep the incident and causal chain through repair.

## Golden fixture format

The fixture supplies a fixed `now`, versioned thresholds, per-class base facts and named
cases (`sync-*`, `fulfillment-*`, `inventory-*`, `workflow-*`). Materialize a case with a
**shallow** merge of its class base and `input`; arrays replace whole arrays. Each base
supplies tenant, subject and synthetic evidence keys. Cases are normalized rule facts, not
connector responses or database rows. Labels such as `tenant-a` are test identities;
persistence tests map them to stable UUIDs. `expected` gives the decision, severity (null
without detection) and reason. Cases must keep positive, negative and uncertain coverage
for each class.

Detection and every downstream recovery integration must satisfy these sequences:

| Sequence                                                              | Required result                                                   |
| --------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Same detected evidence delivered twice                                | One incident, one occurrence, one evidence record.                |
| New evidence, same active fingerprint, changed quantity/error/attempt | Same incident, two occurrences, both evidence records.            |
| Same evidence key with changed facts                                  | Reject conflict; no extra occurrence.                             |
| Same subject text in another tenant or connection scope               | Independent incidents; no evidence access across tenants.         |
| Resolve with verified evidence, then detect again                     | New incident linked to the resolved predecessor.                  |
| Repeat while escalated/failed                                         | Update existing active incident.                                  |
| Failed scan after last-good snapshots                                 | Preserve snapshots; no inferred deletion or automatic resolution. |
| Partial write receipt or unknown effect followed by unsuccessful read | Remain unresolved, reconcile/escalate, zero redispatches.         |
| Fresh independent evidence proves postcondition                       | Resolve with verification and audit references.                   |
| Only stale/partial/uncertain recovery evidence                        | Remain unresolved; request authoritative refresh.                 |

Detection output never grants execution. Resolution follows ADR-002: passed verification,
or an explicit human disposition with actor, reason and evidence. A human disposition is
never counted as autonomous verified success.

## Changes

- **`v0.1`, `sync_failure` lost access.** Added the optional fact `accessLost` and the
  decision `detect`/`high`/`access_lost`, evaluated before the inactive-connection branch.
  Inputs without the fact evaluate as before, so the version stays `v0.1` and stored
  evaluations remain reproducible. Golden case: `sync-access-lost`.
- **`v0.2`, `inventory_mismatch` pending sync.** Added the optional fact `mismatchSince`,
  the thresholds `propagationSeconds` and `oversellGuardPercent`, and
  the decision `defer`/`propagation_pending`. Inputs without the facts evaluate as in
  `v0.1`. A threshold change needs a new configuration version, so open cases are
  reevaluated on their next pass. Golden cases: `inventory-propagation-*` and
  `inventory-oversell-guard*`.

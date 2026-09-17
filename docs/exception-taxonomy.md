# V0 exception taxonomy and golden cases

Version: `v0.1`. Owner: exceptions. Implementation handoff: [LUMA-19](https://linear.app/auren-labs/issue/LUMA-19). Decision: [LUMA-15](https://linear.app/auren-labs/issue/LUMA-15).

Four classes use the names and lifecycle in [ADR-002](architecture/002-canonical-commerce-model.md). Rules consume normalized evidence, never provider payloads. [Golden cases](fixtures/exceptions-v0.json) specify inputs and expected decisions; they are synthetic acceptance vectors, not customer incidents. Fixture integrity checks run in `pnpm test`. LUMA-19 must run its detector against these expected results and add persistence/concurrency tests.

## Evidence and confidence

Reviewed on 2026-09-17:

| Source                                                                                                                                    | Supported finding                                                                                                    | Rule implication                                                                           |
| ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| [Shopify webhook guidance](https://shopify.dev/docs/apps/build/webhooks)                                                                  | Events may arrive out of order or be missed; reconciliation is required.                                             | Missing webhooks alone do not prove synchronization failure. Preserve ordering and reread. |
| [Shopify fulfillment states](https://shopify.dev/docs/api/admin-graphql/2026-07/enums/FulfillmentOrderStatus)                             | Work can be scheduled, held, processing, incomplete or closed.                                                       | Pending work is not automatically stuck; closure is not independent shipment evidence.     |
| [Shopify inventory quantities](https://shopify.dev/docs/apps/build/orders-fulfillment/inventory-management-apps/manage-quantities-states) | Inventory has distinct quantities per location.                                                                      | Compare available stock only across equivalent units and mapped stock pools.               |
| [JTL adapter evidence](jtl.md), [Shopify adapter evidence](shopify.md)                                                                    | Existing contract tests preserve negative/fractional quantities, split operations, unknown fields and read failures. | Use normalized snapshots; do not infer missing JTL operations or writes from read support. |
| [JTL-Worker configuration](https://guide.jtl-software.com/jtl-wawi/jtl-worker/jtl-worker-einrichten-und-konfigurieren/)                   | Sync jobs have configured intervals and require a running worker with access.                                        | Check job evidence and configuration before attributing lag to a failed worker.            |
| [Temporal activity execution](https://docs.temporal.io/activity-execution)                                                                | Activities can retry; side effects need idempotency.                                                                 | A worker failure is not proof that an effect did not occur.                                |
| [Execution recovery](execution.md)                                                                                                        | Durable attempts require reconciliation after uncertain effects.                                                     | Worker retry advice never authorizes replay of an ambiguous write.                         |

The [Validation Scorecard](https://linear.app/auren-labs/document/validation-scorecard-and-evidence-log-d63f89b59916) contains a collection template but no customer cases. [LUMA-12](https://linear.app/auren-labs/issue/LUMA-12) is Todo with no discovery comments as of this review. Frequency, commercial impact and thresholds below are hypotheses, not validated customer findings. Add incident links and recalibrate a new rule version when discovery lands; retain these vectors for regression comparison.

## Shared evaluation contract

- Evaluate with an injected UTC `now`; never use the machine clock in fixtures. `v0.1` uses elapsed time, not business hours.
- Read trusted tenant context and explicit source-to-canonical mappings. Same SKU labels, order numbers or external IDs never establish identity. Reject cross-tenant evidence before rule evaluation.
- Every decision records rule/config version, subject, source/connection scope and immutable evidence references. Evidence includes observation/event IDs, observed/source times, adapter/schema versions and normalized facts. Keep secrets and customer payloads out of facts. References must remain interpretable after raw payload expiry.
- `detect` creates/updates an incident; `clear` means the rule did not fire, **not** permission to resolve an existing incident; `defer` means evidence is insufficient and requests a read/mapping review; `reject` means invalid tenant provenance. Deferred decisions never authorize writes. If uncertainty remains for 30 minutes from the first deferred evaluation, escalate an existing incident or emit an operator review task; do not invent a mismatch.
- Fresh means `0 <= now - observedAt <= 300 seconds`. Reject future observations as uncertain. Inventory pairs additionally require observation skew `<= 60 seconds`. Fresh authoritative polls can have null source-update times (JTL inventory); source-update time is not the poll freshness clock. Out-of-order/ambiguous projections must be reread before evaluation.
- All thresholds are fixture defaults, not service promises: freshness 300 s, pair skew 60 s, sync retry window 900 s, stuck progress 7,200 s, uncertainty escalation 1,800 s, inventory tolerance `0`. Persist a versioned tenant configuration; changing a value requires reevaluation and invalidates stale proposals.
- Use exact decimal arithmetic (up to 14 integer and 6 fractional digits). Null is unknown, zero is known, and negative/fractional stock remains valid. Never infer available stock from on-hand minus reserved.

### Evaluation order

After schema validation, reject tenant mismatches first. Within each class, use the first applicable branch:

1. **Sync:** inactive → successful complete scan → successful incomplete scan (defer) → hard error → transient error window → unclassified error. Future failure-window timestamps defer.
2. **Fulfillment:** missing mappings/completeness or stale/future observation → unknown status → terminal status → unknown/negative quantity or unknown unit → zero quantity → explicit failure → exempt eligibility → unknown eligibility → null/future progress → age threshold. Failure detection does not require a progress timestamp. Eligibility is resolved by the caller from current exemption evidence; a bare pending status is insufficient.
3. **Inventory:** missing SKU/pool mapping → incomplete/ambiguous projection → null quantities → unknown/different units → non-provider basis → future/stale observations → pair skew → tolerance → severity. Oversell severity requires the selling source and authority to be different sources.
4. **Workflow:** missing durable evidence → unknown effect → intentional cancellation → healthy running/succeeded → exhausted failed/timed-out step → pending retry. An interrupted step with known no effect defers for a durable terminal/retry decision. Unknown effects take precedence over cancellation or reported success.

Malformed facts fail validation before evaluation; do not turn invalid numeric strings or timestamps into healthy outcomes. All `defer` branches leave existing incidents unresolved.

### Identity, repetition and overlap

Fingerprint material is the canonical JSON array `["v0", class, ruleIdentity, subjectKind, subjectId, scope]`, hashed with SHA-256 within the tenant. Rule identities below are stable across threshold/version edits. `scope` is an ordered array, defined per class; do not include timestamps, quantities, error text or attempt numbers. The database uniqueness key includes tenant ID. Source pairs use lexicographically sorted connection IDs.

Deduplicate immutable evidence keys before counting. A repeated delivery adds zero occurrences; new evidence for an active fingerprint adds one occurrence and updates last-detected time. A resolved fingerprint produces a new incident linked to its predecessor. Failed/escalated incidents remain active. A rule version change alone does not split an incident. Reject reuse of an evidence key with different facts.

If a connector failure causes a workflow failure, preserve both subjects and link causation; do not merge their fingerprints. Stale inventory caused by sync failure yields `defer`, not another stock incident. Never sum mirrored JTL and Shopify shipments. Approval and execution records remain separate from detection.

## 1. `sync_failure`

**Systems / subject:** JTL or Shopify connection, its read capability and ingestion job. Subject `connection`; rule identity `connection-read`; scope `[capability]`.

**Normal:** a successful, complete scan for the requested scope advances its checkpoint. Quiet webhook traffic and an idle worker are normal without a scheduled job failure.

**Trigger:** an active connection has a normalized failed read. `authentication`, `permission_denied`, `invalid_response`, `unsupported_capability` or `unsupported_version` detect immediately with severity `high`. `transient`, `timeout` or `rate_limited` detect with severity `medium` only when `retryExhausted = true` and elapsed time since `firstFailureAt >= 900 s`. A success resets the failure window. Other errors defer for classification. Intentional inactive connections are excluded. A failed pagination page qualifies as a read failure; retain every last-good snapshot.

**Evidence:** connection, capability, failed scan/event ID, normalized error code, first/latest failure time, retry exhaustion, retry-after advice and last successful checkpoint. No error-message parsing. Failed or incomplete scans never prove deletion.

**Likely causes:** revoked credentials, missing grants/licence, provider outage, throttling, schema change or broken pagination. These are diagnosis candidates, not facts inferred from an error alone.

**Safe resolution / approvals:** read-only refresh after retry-after/backoff; authorized credential/grant repair by an operator; adapter correction for invalid responses. Never retry authorization errors repeatedly. Reads use existing tenant access; any future side-effecting repair uses execution policy. Current adapters expose reads only; no automatic credential or grant mutation is available.

**Verification:** a new complete successful scan of the same capability and scope, after repair, advances the checkpoint with persisted evidence. One successful page or receipt is insufficient. Authentication success without completion does not resolve a data-sync incident.

**Escalate:** immediate operator review for hard errors; transient failure still present 30 minutes after detection; no authorized credential owner; repeated invalid response; unknown effects on a related write.

**Golden cases:** `sync-*` cover hard errors, retry-window edges, incomplete pagination, disabled connections and unclassified errors.

## 2. `stuck_fulfillment`

**Systems / subject:** normalized JTL delivery-note or Shopify fulfillment operation plus its order/line mapping. Subject `fulfillment`; rule identity `fulfillment-progress`; scope `[connectionId]`. Separate split operations retain separate identities.

**Normal:** positive work progresses within 7,200 s; shipped/delivered/cancelled work is terminal for this rule. Explicitly scheduled/held work is excluded while a current, trusted exemption is in force. Expired exemptions resume evaluation against the recorded progress time.

**Trigger:** with fresh, mapped, complete operation evidence and known positive line quantity, `failed` detects immediately (`high`), or `pending`/`processing` with `now - lastProgressAt >= 7,200 s` detects (`medium`). A null/future progress time, unknown status, unknown quantity/unit or unresolved hold/schedule eligibility yields `defer`. Zero remaining quantity is clear. Partial shipments do not clear another operation's outstanding work.

**Evidence:** operation/order/line references, quantities, current status, observation time, last progress and its basis, exemption evidence if any. Shopify `updatedAt` is only a progress proxy and can change on unrelated edits. JTL note creation/latest package shipping time is a proxy; no note means no observable operation. Capture that basis in the evidence, not a stronger claim of warehouse inactivity.

**Likely causes:** stock shortage, incomplete address or carrier data, warehouse backlog, connector failure or rejected provider processing. Diagnose with scoped evidence; do not copy personal data into exception facts.

**Safe resolution / approvals:** reread the operation/order and ask the warehouse owner to inspect. A future `fulfillment.retry` proposal must check current state, remaining work, shipment identity and provider idempotency. Treat shipment-affecting actions as high risk: a different owner/admin must approve the immutable intent. Current JTL/Shopify adapters do not support retry writes. Scheduled/held state is not exposed distinctly by current normalized snapshots; eligibility needs separate trusted evidence, otherwise defer pending work.

**Verification:** fresh operation and shipment evidence after action proves the intended line quantities shipped/delivered, or a reviewed cancellation disposition. Progress alone can remove the age trigger but cannot claim fulfillment success. Never treat a tracking label, Shopify closed work item or accepted retry as shipment proof.

**Escalate:** immediate for explicit failure, missing approval/capability or ambiguous shipment; after another 7,200 s without progress following detection; unresolved eligibility after the shared uncertainty window. Do not retry shipment effects with unknown outcomes.

**Golden cases:** `fulfillment-*` cover split work, threshold edges, legitimate holds, missing progress, unknown status, failure and terminal work.

## 3. `inventory_mismatch`

**Systems / subject:** JTL and Shopify inventory snapshots for an explicitly mapped SKU and equivalent stock pool. Subject `sku`; rule identity `available-stock`; scope `[canonicalLocationId, ...sortedConnectionIds]`.

**Normal:** comparable, fresh available quantities differ by at most tolerance. Tolerance is inclusive; `abs(left - right) > tolerance` triggers. With the default zero tolerance, any exact difference qualifies.

**Trigger:** both available values are known and provider-reported, units are equal and known, mappings explicitly establish the same SKU/pool, evidence is complete/current, and freshness/skew pass. Difference above tolerance detects `medium`. If an explicitly configured authority exists and the selling source reports more available than that authority, detect `high` with reason `oversell_risk`. This is exposure, not proof of an oversold order. Missing authority permits a medium mismatch but blocks correction direction. Equal negative stock is not a cross-system mismatch.

**Evidence:** both source identities and observations, canonical mappings and their version, available quantities/units/basis, observation and source-update times, authority version, tolerance and exact signed difference. JTL `all-warehouses` cannot match one Shopify location without an explicit stock-pool aggregation mapping. Warehouse on-hand cannot substitute for available stock.

**Likely causes:** lagged sync, distinct pool configuration, reservations, manual edits, mapping error or provider-specific allocation. Establish the authority and stock semantics before selecting a correction.

**Safe resolution / approvals:** authoritative rereads first. A future absolute `inventory.write` proposal requires configured authority, fresh target/source evidence, atomic expected-revision support and new policy evaluation. Treat inventory writes as high risk, requiring a different owner/admin. Neither current adapter exposes writes or conditional revisions; operator correction is the available route. Never use a new proposal merely to replay an uncertain write.

**Verification:** after correction, reread both equivalent pools; fresh complete values agree within tolerance, and the approved postcondition holds under the same mappings/authority. Accepted writes and old snapshots cannot resolve the incident.

**Escalate:** immediate for oversell risk, ambiguous authority or unsafe write support; uncertainty persists 30 minutes; mismatch still present 30 minutes after detection; verification fails or a write outcome is unknown.

**Golden cases:** `inventory-*` cover exact/fractional/negative values, zero versus null, tolerance, stale/skewed evidence, units, pool mapping, authority and tenant isolation.

## 4. `workflow_failure`

**Systems / subject:** durable workflow/worker execution and any linked connector action. Subject `workflow_run`; rule identity `workflow-step`; scope `[stepKey]`.

**Normal:** running, successful or intentionally cancelled work; scheduled retry within its budget. A missing heartbeat alone is insufficient without a durable timeout/failure event.

**Trigger:** a durable terminal `failed`/`timed_out` step with exhausted retries detects `high`. An execution interrupted with a durable prepared/running/unknown effect also detects `high`, reason `reconciliation_required`, even if retries remain. Use the stable run/step identity; changing attempt number does not create another incident. A nonterminal failure without unknown effect is clear while retries remain. Missing durable evidence defers.

**Evidence:** failure event ID/time, run UUID, step key, attempt, normalized code, terminal status, retry budget and linked execution/attempt IDs with effect certainty. Do not infer workflow state from raw worker logs or require a particular runtime payload.

**Likely causes:** exhausted external retries, invalid input, deployment crash, unavailable dependency or lost completion persistence. A worker crash does not prove the external effect failed.

**Safe resolution / approvals:** inspect and reread first. Unknown effects call read-only execution reconciliation; never redispatch. A future known-no-effect workflow retry must preserve logical idempotency and recheck intent, policy and business preconditions. Read-only retry needs scoped access; medium/high-risk business effects require independent owner/admin approval. The current single-attempt execution service has no redispatch protocol or registered workflow retry capability.

**Verification:** a durable successful step and fresh evidence of its intended business postcondition, with linked execution verification where effects exist. A healthy restarted worker or an accepted activity is not recovery proof. Reconciliation with passed verification can close the business incident; unrelated later runs cannot.

**Escalate:** immediately for unknown effects without conclusive reconciliation, exhausted retries or missing capability; to an operator for code/configuration changes. Preserve the incident and causal chain through repair.

**Golden cases:** `workflow-*` cover exhausted failures/timeouts, scheduled retries, missing durable evidence, intentional cancellation and crash-after-dispatch.

## Golden fixture format and implementation acceptance

`fixtures/exceptions-v0.json` supplies fixed `now`, versioned thresholds, per-class base facts and named cases. Materialize a case with a **shallow** merge of its class base and `input`; arrays replace whole arrays. Each base supplies tenant, subject and synthetic evidence keys. Fixtures are normalized rule facts, not serialized connector responses or database rows. Labels such as `tenant-a` are test identities; persistence tests must map them to stable valid UUIDs.

`expected` specifies decision, severity (null without detection) and reason. The fixture test validates shape, clocks, IDs and positive/negative/uncertain coverage. It does not claim a production detector exists. LUMA-19 must assert every expected result using its real evaluator and retain the following sequence assertions:

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

Detection output never grants execution. Resolution follows ADR-002: passed verification, or explicit human disposition with actor, reason and evidence. Human disposition is not counted as autonomous verified success.

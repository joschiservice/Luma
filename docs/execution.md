# Policy, execution and audit

Every external write goes through one path: action admission, policy and approval, a
single durable dispatch reservation, then independent verification, with append-only
audit evidence at each step. A successful provider call is never verification, and
retries, restarts and redelivery never dispatch a second write. `@luma/policies`,
`@luma/execution` and `@luma/audit` own the rules; `@luma/application-runtime` composes
them with identity, an eligibility reader and the trusted effect registry.

## Action admission

Callers execute a run step by reference only (`runId`, `stepId`). Passing a proposal,
capability, target, tenant, principal, credentials or parameters fails validation. The
service loads the run's immutable authority and bound step inputs, then checks the exact
activated artifact ID, version and SHA-256 digest. The artifact allows a capability and
version, target kind and minimum risk per step; the action must match them and its stored
hash.

- Activation is an explicit trusted step; generating an artifact never activates it.
  Revocation is permanent for that version.
- Run authority binds tenant, initiating principal, artifact, incident and diagnosis
  revision. A run cannot acquire another principal or artifact through a later step. Each
  step binds one proposal permanently, and a proposal belongs to one step.
- The composition root supplies an independent eligibility reader; the default denies.
  Resolution eligibility reloads the current diagnosis and checks its revision, readiness,
  expiry and evidence membership. Bound evidence must be at most five minutes old by
  default and never future-dated. The effect binding separately validates target
  ownership, connection scope, parameter mapping and provider preconditions.
- Admission rechecks activation, current membership and eligibility after the reservation
  reaches audit and before dispatch. Admission metadata does not change the proposal hash,
  so approvals stay bound to the same action.

The installed connector runtime exposes only `read` and `discover`. Write registries are
built in trusted composition and held by the private execution engine. Interpreted callers
get one admission function bound to a trusted context and run, with no database,
credentials, handlers or network access. Generated code is never evaluated in the server
process. API, deterministic-browser and sandboxed-code effect adapters all enter the same
admission and reservation path; a code runner must enforce its own process and network
isolation.

### Runtimes

The API, the workflow worker, the commerce sync process (mailbox reading and supplier
follow-up) and the pilot compose the same effect registry from the installed apps. A
runtime with enabled execution and the installed purchase-order, return and mailbox runtimes
resolves the same adapter for an action as every other runtime: the same dispatch identity,
mechanism and executor. An attempt reserved in one process can therefore be reconciled in
another. A runtime without execution, or the API without connection settings, resolves none
of those provider writes.

People's approvals send at once from the API, as the requester. Approved purchase orders and
replies whose send did not start are sent by the commerce sync passes, also as the
requester, and those passes reconcile uncertain ones by reading. The workflow worker's
return step follow-up reconciles sent refunds, restocks and exchange steps by reading while
it checks return money. No worker activity proposes or approves these writes; it only
executes or reconciles the bound action under its recorded approval.

Provider runtimes record no capability telemetry and keep no read observations. Each owner
stores the evidence it uses, such as procurement's purchase-order observations, so
verification does not depend on the runtime that read.

## Observe-only

Owners choose `observe_only` or `writes_enabled` for the workspace. New workspaces
observe only; existing workspaces retain their prior write behavior. A connection can
add an observe-only override or inherit the workspace. It cannot enable writes against
an observe-only workspace. Changes use reviewed revisions, refresh owner authority and
retain before/after audit evidence.

Detection, diagnosis and immutable proposals continue in observe-only. The shared
execution engine records a terminal `not_executed` result with reason `observe_only`
before policy approval or dispatch reservation. It retains the proposed action and its
evidence without making a provider write. API, worker, pilot and simulator composition
all use this engine. Reservation shares the mode-change fence, and dispatch checks the
mode again after audit persistence. A change after reservation withholds dispatch using
the existing attempt's certainty model; a provider request already sent is not cancelled.

Workers stop normally on the recorded result. Replays and restarts never redispatch that
proposal, even after writes are enabled. A fresh proposal and the usual admission,
approval and verification controls are required to act later. Existing uncertain writes
can still be reconciled by independent reads. Observe-only outcomes belong to their own
measurement environment and never count as verified resolutions.

## Policy and approval

Policy `v0.1` lets people with the step's permission execute registered capabilities: the
capability's own permission when it declares one, otherwise `actions.execute`
(`actions.propose` when preparing a proposal). Otherwise the decision is
`permission_denied`. The registry must resolve an active tenant-owned connection, check the
exact capability version, validate parameters and target/evidence ownership, and read
current preconditions. Missing capabilities or false preconditions deny; registry errors
stop execution.

Low-risk actions run without approval. Medium or high risk, from the proposal or the
adapter metadata, needs approval with `decisions.respond` (and the
capability's app permission, if any). The [workspace approval preference](workspace-settings.md#approval-preference) controls whether the approver must be a different person. Independent approval is off while fewer than two active members have access; an explicit response is still required. Responses are `approved` or `rejected`, expire within
24 hours, and the first response wins. Grants bind tenant, proposal hash, requester and
policy version. Rejection and expiry never authorize an effect and cannot be overwritten; a
new proposal is needed. A rejection stays binding after its expiry and if adapter risk is
later lowered. Membership is rechecked when executing, approving and reconciling.

A policy decision expires after 30 seconds or at the earlier proposal, evidence or approval
expiry, and execution checks that deadline again after persisting the prepared audit
event. Authorization happens before the call and is not a transaction with the provider:
adapters must use provider-side conditional writes where changes between preflight and
dispatch matter.

## Immutable intent and idempotency

The validated proposal binds tenant, target, connection, capability and version, scalar
parameters, evidence references and freshness, expected postcondition, risk, expiry and
proposer provenance. The proposer must be the authenticated user. Caller-supplied model
metadata and service, agent or connector proposer claims are rejected, because identity
has no delegation authority. Agent executor provenance (model, provider, version, prompt
version, run ID) comes from the trusted adapter. The hash is SHA-256 over canonical JSON
with sorted keys. The first accepted proposal ID binds its content permanently, including
while awaiting approval; changed intent needs a new UUID.

The logical execution key is `v0:<proposal UUID>`, unique within a tenant; adapters keep
tenant and connection scoping when mapping it to a provider key. A unique reservation
permits one dispatch. Concurrent or repeated calls return the stored result, or
`reconciliation_required` for an interrupted attempt. Each proposal has a single attempt:
there is no provider-safe retry or compensation protocol, and callers must not create a
new proposal just to retry an ambiguous write.

Parameters and postconditions hold only minimal non-sensitive command data. Keep
credentials, customer payloads, screenshots and chain-of-thought out; reference controlled
evidence by tenant-owned UUID.

## Attempts and verification

Each attempt records dispatch separately from business outcome:

- `dispatch`: `not_dispatched`, `dispatched` or `uncertain`.
- `businessOutcome`: `pending`, `satisfied`, `violated` or `inconclusive`.

A prepared reservation starts as uncertain and pending, because a crash can happen on
either side of the provider call. A withheld call records `not_dispatched`, an accepted
response `dispatched`. Thrown calls stay uncertain unless the adapter reports dispatch
certainty explicitly. Provider request IDs are kept in the attempt and completion audit
when supplied.

Verification performs a fresh authoritative read, checks the expected postcondition and
returns the outcome, observation IDs, observation time and evaluator version. Observations
predating the attempt, malformed responses and thrown reads produce an unknown outcome;
only a passed check is success. The verifier must prove the selected business postcondition: a
corrected shipping method, for example, does not prove that fulfillment resumed. Closing
the incident still needs [exception verification](exception-detection.md#resolution).

## Recovery

Reconciliation only reads. A passed verification can settle a prepared or unknown
attempt and establishes the business outcome, not whether a lost response was delivered.
Negative and inconclusive observations are stored with audit evidence but cannot prove a
delayed request will not commit, so the attempt stays blocked and its reservation is not
consumed; an in-flight dispatch can still record its receipt. Reconciliation keeps
dispatch certainty and the reserved provider identity and never redispatches. If it cannot
establish success, escalate to a person instead of retrying. Attempts recorded without a
dispatch identity reconcile only with a matching mechanism and executor.

Policy records, approval responses, reservations and completions commit together with
their outbox events. The effect is called only after the policy and prepared events reach
the audit log, and transactions end before any connector I/O. Audit ingestion accepts
exact replays and rejects conflicting event keys. Policy outboxes drain on policy
evaluation and approval; execution outboxes drain on execution and reconciliation. After a crash or audit outage, redeliver the same
activity input: pending evidence is flushed without repeating the effect, and a process
that died after the remote commit leaves a prepared record that forces reconciliation.
Audit entries hold policy, attempt and connection references, provenance and evidence
references, never exception messages or provider payloads.

## Storage and operation

All safety tables use forced RLS on the transaction-local tenant and queries also filter
by tenant. Runtime roles cannot update or delete policy or audit evidence, rewrite intent
receipts or delete execution history; a trigger preserves intent, attempt identity and
final results, and outbox roles may update only delivery timestamps. Append-only is not
cryptographic tamper-proofing: migration and retention credentials stay privileged. The
safety login must be a non-owner, non-superuser role without `BYPASSRLS` (see
[database roles](development.md#database-roles)), and the process must run in the
tenant's configured region. See [module ownership](architecture/001-module-boundaries.md) and
[tenant isolation](architecture/003-tenant-isolation-and-data-residency.md).

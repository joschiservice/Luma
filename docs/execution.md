# Policy, execution and audit

Workflow activities call `execution.execute(context, { runId, stepId })` through `createSafetyServices` in `@luma/application-runtime`. The composition root supplies identity, independent eligibility checks and a trusted connector registry. Activities receive the admission port; connector writes stay in the private execution engine. The [durable workflow runtime](exception-workflows.md) registers Temporal activities around these services. Production connector writes require an installed effect adapter.

## Policy and approval

Policy `v0.1` allows people with the step's permission to execute registered capabilities: the capability's own permission when it declares one, otherwise `actions.execute` (`actions.propose` when preparing a proposal). Without it the decision is `permission_denied`. The registry must resolve an active connection owned by the tenant, check the exact capability version, validate capability-specific parameters and target/evidence ownership, and read current preconditions. Missing capabilities or false preconditions deny execution. Registry errors stop execution.

Low-risk actions run without approval. Medium/high risk, from either the proposal or adapter metadata, requires a different person with `decisions.respond` (and the capability's app permission, if any) to approve. `policies.respond(context, decisionId, outcome, expiresAt)` accepts `approved` or `rejected`; expiry must be within 24 hours. The first response wins. Grants bind tenant, proposal hash, requester and policy version. Rejection and expiry never authorize an effect. A rejected or expired grant requires a new proposal; it cannot be overwritten. Rejection remains binding after its expiry and when adapter risk is lowered. Recheck membership when executing, approving and reconciling.

Decisions expire after 30 seconds or at the earlier proposal, evidence or approval expiry. Execution checks this deadline again after persisting the prepared audit event. Authorization is checked before the call; it is not a transaction with a remote provider. Connector implementations must enforce provider-side conditional writes where changes between preflight and dispatch matter.

## Immutable intent and idempotency

The runtime-validated proposal binds tenant, target, connection, capability/version, scalar parameters, evidence references/freshness, expected postcondition, risk, expiry and proposer provenance. Proposer identity must match the authenticated user, including any initiating user ID. Caller-supplied model metadata and service/agent/connector proposer claims are rejected before persistence because the current identity context has no delegation authority. Agent executor provenance comes from the trusted adapter and includes model/provider/version, prompt version and run ID. SHA-256 covers canonical JSON with sorted object keys. The first accepted proposal ID binds this content permanently, including while awaiting approval. Changed intent needs a new UUID.

The logical execution key is `v0:<proposal UUID>`, unique within a tenant. Adapter implementations must preserve tenant/connection scoping when translating it to a provider key. A unique database reservation permits one dispatch. Concurrent or repeated calls return the stored result, or `reconciliation_required` for an interrupted attempt; they never dispatch again.

This minimum implementation stores one numbered attempt inside the execution document. Additional provider-safe retries and compensation require a later execution protocol; callers must not manufacture a new proposal solely to retry an ambiguous write. The immutable execution intent is a receipt of the proposal, not the exceptions module's proposal lifecycle.

## Evidence and recovery

Policy decisions and approval responses are immutable records. Each record and its policy outbox event commit together. Execution reservation/completion and their outbox events also commit together. Audit ingestion accepts exact replay and rejects conflicting event keys. The effect is called only after the policy and prepared events reach the audit log. Database transactions end before any connector I/O.

A request returning successfully is not verification. `verify` performs a fresh authoritative read, checks the supplied expected postcondition, and returns its outcome, observation UUIDs, observation time and evaluator version. Observations predating the attempt, malformed responses and thrown operations produce an unknown outcome. Only passed verification produces success. Audit entries include policy/attempt/connection references, proposer/executor provenance and evidence references. Exception messages and provider payloads are not copied into audit.

`execution.reconcile(context, proposalId)` performs reads only. Passed verification can resolve a prepared/unknown attempt. A negative or inconclusive read is persisted with its audit evidence. It cannot prove a delayed request will not commit, so it leaves the attempt blocked. If reconciliation cannot establish success, escalate for human review; do not blindly retry.

After a crash or audit outage, redeliver the same activity input. The service flushes its pending evidence without repeating the effect. Policy outboxes are drained on policy evaluation/approval; execution outboxes are drained on execution/reconciliation. The Temporal runtime redelivers interrupted activities and routes prepared/unknown attempts to reconciliation. Operator recovery remains available for escalated work. If the process died after the remote commit but before local completion, the durable prepared record forces reconciliation.

Parameters and postconditions must contain only the minimum non-sensitive command data. Keep credentials, customer payloads, screenshots and chain-of-thought outside these records. Use tenant-owned UUID references to controlled evidence storage.

## Database and operation

Run `pnpm --filter @luma/api db:migrate` with `MIGRATION_DATABASE_URL`. Migration `0002_policy_execution_audit.sql` creates policy records, intent receipts, execution records, outboxes and audit entries. The existing migration runner applies both migrations in order and checks applied checksums.

Grant the safety service's non-owner, non-superuser, non-`BYPASSRLS` login membership in `luma_policies`, `luma_execution` and `luma_audit`. Identity keeps its existing `luma_identity` credentials. `createSafetyServices(databaseUrl, identityService, registry)` owns a separate pool; call `close()` during shutdown. The process must run in the tenant's EU placement.

All safety tables use forced RLS with transaction-local `app.tenant_id`. Queries also filter by tenant. Runtime roles cannot update/delete policy or audit evidence, rewrite intent receipts, delete execution history or truncate tables. A trigger preserves execution intent, attempt identity and finalized results. Outbox roles may update only delivery timestamps. Separate migration/retention credentials remain privileged; append-only does not mean cryptographically tamper-proof.

The implementation follows [module ownership](architecture/001-module-boundaries.md), [canonical intent/evidence conventions](architecture/002-canonical-commerce-model.md), and [tenant isolation](architecture/003-tenant-isolation-and-data-residency.md). It uses versioned JSON documents for the initial single-attempt record, with indexed tenant/proposal/hash/state columns and database constraints. Future retries can normalize attempts without changing proposal hashes or idempotency keys.

## Validation

```sh
TEST_DATABASE_URL=postgresql://... pnpm --filter @luma/api test
pnpm check
```

Integration tests create isolated databases and restricted runtime logins on PostgreSQL 17. They cover authorization, approval/rejection/expiry, current membership, capability risk, tenant isolation, canonical hashes, concurrent delivery, restart recovery, stale verification, audit outages, lost completion persistence and immutable evidence. CI supplies PostgreSQL separately in each test job. Without `TEST_DATABASE_URL`, database integration tests are skipped.

## Action admission

`createSafetyServices` exposes admission as `execution`. `execute(context, { runId, stepId })` accepts references only. Passing a proposal, capability, target, tenant, principal, credentials or parameters in that request fails validation. The service loads immutable run authority and bound step inputs, then checks the exact activated artifact ID, version and SHA-256 digest. The artifact allows a capability/version, target kind and minimum risk for each step. The action must match these permissions and its stored hash.

Trusted composition uses `provisioning.activate` to activate a reviewed artifact and `provisioning.bind` to bind a run step. Activation is explicit; generation does not activate an artifact. Run authority binds the tenant, initiating principal, artifact, incident and diagnosis revision. A run cannot acquire a different principal or artifact through another step. Each step binds one proposal permanently, and a proposal cannot belong to multiple steps. Revocation is permanent for that version.

The composition root supplies an independent eligibility reader. The default denies execution. `createAdmissionEligibility` reloads the current diagnosis and checks its revision, readiness, expiry and evidence membership. Bound evidence must be no older than the configured window (five minutes by default) and cannot be dated in the future. The connector effect binding separately validates target ownership, connection scope, parameter mapping and provider preconditions. Admission checks activation, current membership and eligibility again after the reservation reaches audit and before dispatch. The existing policy service independently enforces fresh intent, approval and adapter risk. Admission metadata does not change the proposal hash, so existing approvals remain bound to the same immutable action.

`createExceptionWorkflowRuntime` binds its `execute` step during trusted proposal preparation and submits only references. Its default artifact reference is `exception-resolution/1`; composition must activate a reviewed artifact for the selected action. The default worker still has no production effect adapter. LUMA-25 must supply the selected installed effect registry, eligibility reader and activated artifact.

The installed connector runtime exposes only `read` and `discover`. Raw runtime and handler factories are absent from connector public and composition exports. Installed write registries are created in trusted composition and retained by the private execution engine. `bindActionAdmission` provides interpreted callers one function bound to a trusted context and run; it exposes no database, credentials, handlers or network transport. Generated code is not evaluated in the server process. API, deterministic-browser and sandboxed-code effect adapters all enter the same admission and reservation path. A future code runner must enforce its process and network isolation separately.

Migration `0012_action_admission.sql` adds tenant-isolated artifact, run and step records. Runtime roles cannot rewrite or delete their documents. It also permits durable reconciliation evidence updates while preserving intent, provider identity and terminal results.

Each new attempt records dispatch separately from business outcome:

- `dispatch`: `not_dispatched`, `dispatched` or `uncertain`.
- `businessOutcome`: `pending`, `satisfied`, `violated` or `inconclusive`.

A prepared reservation starts with uncertain dispatch and a pending outcome because a process crash can occur on either side of the provider call. A withheld call records `not_dispatched`. An accepted response records `dispatched`; only fresh authoritative verification determines the business outcome. Thrown calls remain uncertain unless the adapter provides explicit dispatch certainty. Provider request IDs, when supplied, are retained in the attempt and completion audit. JTL shipping-method writes retain a valid `x-request-id` response header.

Reconciliation preserves dispatch certainty and the reserved provider identity. It stores negative and inconclusive observations and audit evidence without permitting redispatch. Successful reconciliation establishes the verified outcome, not whether a previously lost response was delivered. The verification adapter must prove the selected business postcondition; shipping-method correction alone does not prove that fulfillment resumed.

Migration `0013_preserve_prepared_reconciliation.sql` lets negative reconciliation observations update a prepared attempt without consuming its reservation. An in-flight dispatch can still persist its receipt and verified outcome. Attempts created before dispatch identities were recorded reconcile only with a matching mechanism and executor; newer attempts require the exact stored dispatch identity. Recovery never dispatches another write.

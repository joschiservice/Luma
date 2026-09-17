# Policy, execution and audit

Workflow activities call `execution.execute(context, proposal)` through `createSafetyServices` in `apps/api/src/app.ts`. The composition root supplies identity and a trusted connector registry. An activity receives the execution service; connector write adapters stay in composition and execution. No provider writes or Temporal worker are registered by this foundation.

## Policy and approval

Policy `v0.1` allows active EU organization owners and admins to execute registered capabilities. Members cannot execute effects. The registry must resolve an active connection owned by the tenant, check the exact capability version, validate capability-specific parameters and target/evidence ownership, and read current preconditions. Missing capabilities or false preconditions deny execution. Registry errors stop execution.

Low-risk actions run without approval. Medium/high risk, from either the proposal or adapter metadata, requires a different owner/admin to approve. `policies.respond(context, decisionId, outcome, expiresAt)` accepts `approved` or `rejected`; expiry must be within 24 hours. The first response wins. Grants bind tenant, proposal hash, requester and policy version. Rejection and expiry never authorize an effect. A rejected or expired grant requires a new proposal; it cannot be overwritten. Recheck membership when executing, approving and reconciling.

Decisions expire after 30 seconds or at the earlier proposal, evidence or approval expiry. Execution checks this deadline again after persisting the prepared audit event. Authorization is checked before the call; it is not a transaction with a remote provider. Connector implementations must enforce provider-side conditional writes where changes between preflight and dispatch matter.

## Immutable intent and idempotency

The runtime-validated proposal binds tenant, target, connection, capability/version, scalar parameters, evidence references/freshness, expected postcondition, risk, expiry and proposer provenance. Agent provenance includes model/provider/version, prompt version and run ID. SHA-256 covers canonical JSON with sorted object keys. The first accepted proposal ID binds this content permanently, including while awaiting approval. Changed intent needs a new UUID.

The logical execution key is `v0:<proposal UUID>`, unique within a tenant. Adapter implementations must preserve tenant/connection scoping when translating it to a provider key. A unique database reservation permits one dispatch. Concurrent or repeated calls return the stored result, or `reconciliation_required` for an interrupted attempt; they never dispatch again.

This minimum implementation stores one numbered attempt inside the execution document. Additional provider-safe retries and compensation require a later execution protocol; callers must not manufacture a new proposal solely to retry an ambiguous write. The immutable execution intent is a receipt of the proposal, not the exceptions module's proposal lifecycle.

## Evidence and recovery

Policy decisions and approval responses are immutable records. Each record and its policy outbox event commit together. Execution reservation/completion and their outbox events also commit together. Audit ingestion accepts exact replay and rejects conflicting event keys. The effect is called only after the policy and prepared events reach the audit log. Database transactions end before any connector I/O.

A request returning successfully is not verification. `verify` performs a fresh authoritative read, checks the supplied expected postcondition, and returns its outcome, observation UUIDs, observation time and evaluator version. Observations predating the attempt, malformed responses and thrown operations produce an unknown outcome. Only passed verification produces success. Audit entries include policy/attempt/connection references, proposer/executor provenance and evidence references. Exception messages and provider payloads are not copied into audit.

`execution.reconcile(context, proposalId)` performs reads only. Passed verification can resolve a prepared/unknown attempt. A negative or inconclusive read cannot prove a delayed request will not commit, so it leaves the attempt blocked. If reconciliation cannot establish success, escalate for human review; do not blindly retry.

After a crash or audit outage, redeliver the same activity input. The service flushes its pending evidence without repeating the effect. Policy outboxes are drained on policy evaluation/approval; execution outboxes are drained on execution/reconciliation. An operator or workflow recovery job must redeliver interrupted work; this change does not install a background dispatcher. If the process died after the remote commit but before local completion, the durable prepared record forces reconciliation.

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

Integration tests create isolated databases and restricted runtime logins on PostgreSQL 17. They cover authorization, approval/rejection/expiry, current membership, capability risk, tenant isolation, canonical hashes, concurrent delivery, restart recovery, stale verification, audit outages, lost completion persistence and immutable evidence. CI supplies PostgreSQL through the existing quality-gates job. Without `TEST_DATABASE_URL`, database integration tests are skipped.

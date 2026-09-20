# Durable exception workflows

LUMA-29 uses Temporal for exception process progress and retry scheduling. PostgreSQL remains the authority for incidents, diagnoses, approvals, execution attempts and audit evidence. The workflow coordinates detection, diagnosis, proposal preparation, policy/approval, execution, business verification and recovery.

## Run the worker

For the managed local environment, run `pnpm dev:workflows`. It starts PostgreSQL,
the Temporal development server and UI, and watches the API, web and worker.
See [local development](development.md). The steps below cover manual setup.

Apply the existing database migrations. Configure `apps/api/.env` using `.env.example`:

- `IDENTITY_DATABASE_URL` and the existing identity settings authenticate membership queries.
- `WORKFLOW_DATABASE_URL` uses a restricted login granted `luma_exceptions`, `luma_policies`, `luma_execution` and `luma_audit`.
- `TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE` and `TEMPORAL_TASK_QUEUE` select the Temporal service and worker queue.
- `TEMPORAL_DATA_REGION=EU` declares the deployment placement. Operators must provision the server, namespace, backups and workers in the approved EU region; the setting cannot verify physical placement.
- `TEMPORAL_TLS=true` is required in production and whenever `TEMPORAL_API_KEY` is supplied. Inject the key as a deployment secret. Custom composition also accepts Temporal TLS certificate options.

Start a local Temporal development server, then build and run the worker:

```sh
temporal server start-dev --ip 127.0.0.1
pnpm exec turbo run build --filter=@luma/api...
pnpm --filter @luma/api worker
```

The development server is for local testing. Use a persistent Temporal deployment for durable operation. The worker drains on SIGINT/SIGTERM and closes its connections and database pools after shutdown. It runs separately from the HTTP server.

The default worker accepts existing incident references, runs persisted diagnosis and returns manual intervention when no executable proposal is available. Current production connectors are read-only. Executable proposals, connector write adapters and authoritative business verification are supplied through the composition bindings for the safe execution loop. The default worker does not invent an action from diagnosis prose or resolve an incident without a verifier.

## Compose and start

`createExceptionWorkflowRuntime` in `apps/api/src/app.ts` wires the existing identity, detection and safety services. It returns `createClient()` and `createWorker()` factories. Call `worker.run()`, then `worker.shutdown()` on shutdown; await the run before `worker.close()`. Close the client and owner services separately. Each worker connection belongs to one namespace/task queue.

The client accepts an authenticated `TenantContext` and a source reference:

```ts
await client.start(context, { kind: 'incident', id: exceptionId });
const progress = await client.progress(context, {
  kind: 'incident',
  id: exceptionId,
});
```

For durable ingestion, pass `{ kind: 'detection', id: deliveryId }` and install `bindings.loadDetection`. That binding must load an immutable, tenant-owned `DetectionRequest` from durable storage. Detection then runs as a retryable activity and retains the existing evidence deduplication semantics. Persist the source before starting the workflow. A producer requiring automatic delivery must retain its start command in a transactional outbox and retry `start` until acknowledged. The default command has no detection-source store; use incident references with it.

Workflow IDs hash the tenant and source kind/ID. Repeated starts return the same workflow, including after completion, without changing its initiating user. Different tenants cannot address one another through the command API. A new immutable detection delivery can start another investigation for the same incident; an identical source never resets a completed run within Temporal's configured retention. Execution receipts still prevent repeat effects after workflow history retention expires. Configure history retention to cover the required operational review period.

The proposal binding provides `prepare(context, diagnosis)` and `get(context, proposalId)`. Preparation must persist once per tenant, incident, diagnosis revision and requester. Reads must return that immutable action and its incident/revision binding. Return null when no supported action exists. The activity checks current diagnosis revision/freshness before dispatch. A changed action needs a new proposal ID. The execution service validates the action, binds its hash, checks adapter availability and evaluates policy before any write.

## Approval and recovery

Progress exposes the current phase and relevant incident, proposal and decision IDs. Policy evaluation and the initial dispatch share the existing execution service's preflight boundary; no independent policy result authorizes a later write.

When `awaiting_approval`, the command layer calls `policies.respond` with the approver's authenticated context. After that transaction commits, call `client.notifyApproval(context, source)`. The signal is a wake-up hint, contains no approval or actor claims, and cannot grant permission. A 30-second durable poll handles a lost notification. Approval waits end at the earliest proposal/evidence expiry or 24 hours. Rejection, expiry and changed membership cannot authorize execution.

Every activity reconstructs the initiating user's context through identity and checks current membership, role, organization status and EU placement. Serialized contexts, sessions, cookies and previously granted roles are not trusted. This is an explicitly started user workflow: session logout does not revoke its initiating user, but membership removal, role loss or organization suspension does.

Activity failures retry up to five attempts within five minutes, with a one-minute attempt timeout. Diagnosis retries honor persisted reread backoff, up to five evaluations and a 24-hour backoff limit. Exhausted retries expose a stable escalation reason. Approval polling and all timers survive worker replacement. The workflow remains bounded; it never loops indefinitely over uncertainty.

Before dispatch, activities check for an existing execution receipt. Prepared/unknown attempts go to read-only reconciliation even if the original diagnosis has expired or its proposal source is unavailable. A lost activity completion, a restart or cancellation after dispatch cannot cause a fresh write. Execution uses `WAIT_CANCELLATION_COMPLETED`, so cancellation waits for its activity to complete or reach its timeout before attempting reconciliation in a non-cancellable scope. A successful or failed activity completion after a cancellation request still leads to a cancelled workflow; unresolved outcomes stay visible in the execution record for operator recovery. Failed or inconclusive reconciliation escalates instead of manufacturing a retry proposal. Cancellation is not compensation.

Only fresh authoritative business verification through `exceptions.verify` resolves the incident. Successful provider execution alone does not resolve it. Detector `clear` results also go through this verifier. Repeated verification delivery recognizes an already committed verified resolution, while a human disposition is not reported as verified.

## Progress and data handling

Temporal history contains source/tenant/user/correlation IDs, diagnosis revision/status, proposal ID/expiry, policy decision ID and finite result codes. It does not contain evidence documents, connector payloads, proposal parameters, credentials, model prompts or arbitrary provider errors. Activity failures are sanitized before persistence. Namespace access must be limited to trusted workers/operators because they can invoke workflows directly.

Process progress is a Temporal projection, not a second incident lifecycle table. The canonical incident is changed only through the exceptions service. Escalation results remain inspectable through `client.progress`; they do not falsely mark the incident resolved. Interrupted workflow statuses report an escalation. The [case decision and progress API](case-decisions.md) exposes persisted review, decisions, execution and verification, audit history and authenticated SSE. Workflow source bindings connect both incident-started and detection-started runs to their case.

## Validation

`pnpm check` includes a local Temporal server integration suite. The SDK downloads/caches the development server binary on first use; CI needs access to Temporal's download service. Tests cover history replay, worker replacement during approval, lost notifications, expiry, diagnosis retry, cancellation, ambiguous effect recovery, verification failure and manual intervention. Activity tests cover tenant scope, revoked access, stale revisions, immutable proposal bindings and verification replay. PostgreSQL execution tests cover durable reservation and single dispatch; `pnpm test:e2e` kills a worker after a provider commit and verifies restart reconciliation.

The lost-notification polling test uses a separate Temporal time-skipping server
to exercise the polling timer without waiting 30 seconds. Its binary is also
downloaded on first use. Apple silicon requires Rosetta 2 for that test server.
The worker-recovery E2E test continues to use the full local Temporal server.

Implementation references: [Temporal TypeScript SDK](https://typescript.temporal.io/), [workflow testing](https://docs.temporal.io/develop/typescript/testing-suite), [execution guarantees](execution.md), [diagnosis revisions](exception-diagnosis.md).

# @luma/worker

Runs Luma's two background processes. Both install instrumentation in a bootstrap file before loading the application.

- **Workflow worker** (`start`, `dev:worker`; `src/bootstrap.ts`): the Temporal worker for exception, process and replenishment workflows. It also advances scheduled workflow starts.
- **Commerce sync worker** (`start:sync`, `dev`; `src/sync-bootstrap.ts`): history import and sync, supplier follow-up and scheduled detection.

The default workflow worker composes execution without effect adapters, so admitted playbook actions fail their capability check and make no provider writes; effects require explicit configuration. Workflow implementation belongs to workflow-temporal and service assembly to application-runtime.

## Health

Set `WORKFLOW_WORKER_HEALTH_PORT` or `COMMERCE_SYNC_HEALTH_PORT` to serve `GET /health` for that process on all interfaces. It answers 200 once startup has checked the database cell, composed the services (including the Temporal connection for the workflow worker) and started the workers, and only while they work: the workflow worker needs both Temporal workers running with their workflow and activity pollers active, and the sync process needs its sync loop to have started a pass or finished a workspace's tick within the last 10 minutes (two page leases; an idle loop checks every 2 seconds). Otherwise it answers 503 with `unhealthy`. It also answers 503 while starting, after a shutdown signal and once the workers stop for any reason, until the process exits. The body names only the state. The variables are separate so both processes can run on one host; unset, no port is opened. Use it for readiness, draining and detecting a stuck worker; the process exits when its workers fail. It covers the sync loop only, not mailbox reading, follow-up, detection or retention.

## Further reading

- [Exception workflows](../../docs/exception-workflows.md)
- [Workflows](../../docs/workflows.md)
- [Commerce sync](../../docs/commerce-sync.md)
- [Package boundaries and runtime composition](../../docs/architecture/005-domain-packages-and-runtimes.md)

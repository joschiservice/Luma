# @luma/worker

Runs Luma's two background processes. Both install instrumentation in a bootstrap file before loading the application.

- **Workflow worker** (`start`, `dev:worker`; `src/bootstrap.ts`): the Temporal worker for exception, process and replenishment workflows. It also advances scheduled workflow starts.
- **Commerce sync worker** (`start:sync`, `dev`; `src/sync-bootstrap.ts`): history import and sync, supplier follow-up and scheduled detection.

The default workflow worker composes execution without effect adapters, so admitted playbook actions fail their capability check and make no provider writes; effects require explicit configuration. Workflow implementation belongs to workflow-temporal and service assembly to application-runtime.

## Further reading

- [Exception workflows](../../docs/exception-workflows.md)
- [Workflows](../../docs/workflows.md)
- [Commerce sync](../../docs/commerce-sync.md)
- [Package boundaries and runtime composition](../../docs/architecture/005-domain-packages-and-runtimes.md)

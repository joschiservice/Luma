# @luma/workflow-temporal

Adapts exception workflows and versioned process workflows to Temporal clients, workers and activities.

Workflow code must stay deterministic; external I/O goes through activities. Business orchestration contracts belong to resolution and workflows; process configuration and resource ownership belong to application-runtime and `apps/worker`.

## Further reading

- [Exception workflows](../../docs/exception-workflows.md)
- [Workflows](../../docs/workflows.md)
- [Package boundaries and runtime composition](../../docs/architecture/005-domain-packages-and-runtimes.md)

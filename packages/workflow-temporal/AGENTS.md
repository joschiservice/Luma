# @luma/workflow-temporal

Temporal adapters for exception workflows, versioned process workflows and stock protection.
PostgreSQL stays the authority; Temporal only drives progress, waits and retries. Read the
[README](README.md) and [durable exception workflows](../../docs/exception-workflows.md)
first.

## Workflow sandbox

- `src/workflows.ts` is the worker's `workflowsPath`. Everything it reaches is bundled into
  the deterministic workflow sandbox, including `runProcess` and the rest of the
  `@luma/workflows` root export graph. Keep I/O, Node built-ins, database and provider access
  in activities, and in `infrastructure` or `composition` of the owning package.
- Workflow modules import domain types with `import type`; the only runtime imports are
  `@temporalio/workflow`, `@temporalio/common`, local workflow helpers and `runProcess`.
- Changing control flow that running histories replay needs a `patched('<id>')` branch, as
  with `automatic-proposal-refresh-v1`. Patch IDs are plaintext history metadata: static
  names only, never tenant data.

## History and payloads

- History holds IDs, revisions, finite result codes and expiry times only, never evidence,
  connector payloads, proposal parameters, credentials, prompts or provider errors. The
  activity wrapper in `src/runtime.ts` logs the original error and sanitizes it before it
  reaches history; the failure converter also encrypts error text and stacks.
- Workflow IDs hash tenant and source. Repeated starts must return the same workflow.
- Signals are wake-up hints with no authority; the durable poll (30 s for approvals) must
  keep working when a signal is lost.

## Effects and cancellation

- Execution activities use `WAIT_CANCELLATION_COMPLETED` and reconcile in a
  non-cancellable scope. A lost completion, restart or cancellation after dispatch must
  never lead to a fresh write; prepared or unknown attempts go to read-only reconciliation.
- Inactive workspaces and suspended members pause through `pauseWhileInactive` with capped
  backoff instead of failing or retrying the activity.
- Process workflows share the `<taskQueue>-procurement` queue; exception workers keep
  their own. Client and worker must agree.

## Tests

`pnpm --filter @luma/workflow-temporal test <file>`. Tests start a real Temporal
development server, downloaded on first use; time-skipping tests need Rosetta 2 on Apple
silicon. They bundle `src/workflows.ts`, so a non-deterministic import fails here first.

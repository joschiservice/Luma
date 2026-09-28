# Sandboxed Code Steps

Code Steps are `workflow/2` instructions interpreted by the existing process engine. They run synchronous TypeScript inside QuickJS compiled to WebAssembly by Javy, supervised by Wasmtime. They do not create a second workflow engine.

## Install and enable

Run `pnpm setup:code`. Set `LUMA_CODE_RUNTIME_DIR` to the printed absolute directory in both the API and workflow worker environments. Apply the normal database migrations, including `0029_code_steps.sql`, and start the existing Temporal workflow worker. Missing runtime files fail closed. Computation-only versions with immediate triggers execute through the existing process task queue; business capabilities require an installed domain adapter. Scheduled native starts retain the existing pending-start behavior; the computation adapter does not advertise scheduled execution.

The installer verifies release archive checksums, builds the guest and checks its platform-specific digest. The runner verifies the guest and executable on every start. Wasmtime 49.0.1, Javy 9.1.0 and TypeScript 5.9.3 are pinned. Imports, exports, async entrypoints and package dependencies are unsupported. Runtime upgrades require a new contract identifier, reviewed artifact hashes, and replay tests. Published versions retain their original binding.

Production requires Linux and `/usr/bin/prlimit` from util-linux. Each child has a 1 GiB address-space limit and a CPU limit derived from its wall-time budget. Wasmtime separately enforces guest linear memory, stack, fuel and elapsed time. The supervisor kills children at their deadline or on cancellation. Host worker threads are bounded; at most four children run per API/worker process. API evaluations additionally allow two concurrent jobs per tenant. Size the worker deployment for those aggregate limits. macOS on arm64 supports development with guest fuel/memory limits and supervised wall-time cancellation.

## Author a version

Use `defineCodeStep` and `compileProcessWorkflow` from `@luma/workflows/composition`, then publish through the existing authorized catalog. Source review and example evaluation are available in **Workflows → Code Steps**. Browser publication of arbitrary source is not exposed.

```ts
function main(input, luma) {
  return { quantity: Math.max(0, input.inputs.target - input.evidence.stock) };
}
```

Declare every returned scalar field. `input` contains the run's typed inputs, evidence facts and completed outer-step outputs. `luma.now` is the run's fixed creation time. Real clocks, randomness, secrets, environment variables, filesystem handles, network and connector handlers are unavailable. The host transpiles types without evaluating source; all user code executes inside Wasm.

A Code Step's grants name the immediately following read or capability nodes. Each capability retains its immediately following verification. Those nodes are owned by the Code Step and are excluded from the outer interpreter. `luma.request('grant-id')` synchronously requests that exact node. Requests cannot supply arbitrary action parameters: the installed domain adapter binds the published inputs. Consequential requests retain admission, policy/approval, reservation, idempotency, connector execution, verification and audit. The replenishment adapter supports this boundary. Other domain adapters must explicitly install it.

The host refreshes authorization before requests. Inputs and fixed time are bound before the first call. Replies are journaled in order before resuming code. Retries replay saved replies and reuse the existing action identity. Approval suspends the instruction and releases its sandbox; approval resumes through deterministic replay. A cancelled or timed-out sandbox cannot send new requests. Already admitted actions may still finish and retain their reconciliation path.

## Evidence and evaluation

Run evidence includes runtime/artifact/input hashes, returned fields, request count, elapsed time and filtered outcome. Linux adds sampled peak process resident memory. Raw guest errors and stderr are discarded because they may contain input values. Code output itself is authorized workflow data, not redacted diagnostic text. Snapshots and replies are stored under tenant RLS; keep secrets out of workflow inputs.

The browser evaluator uses supplied capability replies and a fixed clock, with no live capability adapter. Evaluation IDs bind to their complete request; retry the same body after an uncertain response. Results persist across API restarts. Jobs interrupted by an API restart expire as failed. Cancellation is visible across API instances.

Run `pnpm evaluate:code [corpus.json] [report.json]` for the offline replay gate in `tooling/evaluation`. Each fixture executes twice against ordered example replies. Changed outputs, extra/missing requests or replay differences fail the gate. Reports omit timing measurements so identical fixtures produce identical reports. The checked-in corpus covers replenishment calculation and the no-change branch. This complements the existing provider/admission simulator corpus; it never dispatches production actions.

Validation: workflow unit tests include real sandbox execution when installed, authorization/approval/replay tests, API/PostgreSQL integration, and desktop/mobile browser evaluation. Run `pnpm setup:code` before those suites so sandbox tests are enabled.

### Cancellation and retries

Cancellation and deadlines stop guest execution immediately. An in-flight host request finishes verification and journaling before the activity records its terminal result. Previously verified actions remain visible when code fails or is cancelled. Unexpected host failures retry the durable activity; expected capability denials are terminal.

Inputs and capability replies use canonical JSON key ordering, so equivalent inputs execute with the same ordering as their recorded digest. Rejected example fixtures remain editable. Requests with uncertain network outcomes retain their evaluation ID for safe retries.

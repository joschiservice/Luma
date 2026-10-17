# Sandboxed Code Steps

Code Steps are `workflow/2` steps that run synchronous TypeScript inside QuickJS compiled to
WebAssembly by Javy, supervised by Wasmtime. The existing process runtime interprets them;
they are not a second workflow engine. Code computes values and may request the reads and
actions it was granted, but every consequential request keeps the normal admission,
approval and verification path.

## Install and enable

`pnpm run setup` installs the runtime; `pnpm setup:code` installs it alone. It goes into this
checkout's `.luma/code-runtime`, and the guest is compiled ahead of time so runs do not spend
their wall-time budget on compilation. A rerun skips an installation whose pinned release,
compile flags and file hashes still match; `pnpm setup:code --force` reinstalls. Setup reports
platforms without a pinned runtime (Linux on x64/arm64 and macOS on arm64 are supported) and
continues with Code Steps unavailable, while `pnpm setup:code` fails on them. `pnpm dev`
and `pnpm dev:workflows` pass it to the API and the workflow worker; restart them after
installing. An explicit `LUMA_CODE_RUNTIME_DIR` in `apps/api/.env` takes precedence.

Outside local tooling, set `LUMA_CODE_RUNTIME_DIR` to the printed absolute directory in
both the API and the workflow worker. The runtime is part of the server deployment; no
workspace role can enable it. Missing runtime files fail closed.

The installer verifies release archive checksums, builds the guest and checks its
platform-specific digest; the runner verifies the guest and executable on every start.
Wasmtime, Javy and TypeScript versions are pinned in the runtime identifier. Upgrading any of
them needs a new identifier, reviewed artifact hashes and replay tests. Published versions
keep their original binding.

## Limits

Production requires Linux and `/usr/bin/prlimit` from util-linux. Each child gets a 1 GiB
address-space limit and a CPU limit derived from its wall-time budget. Wasmtime separately
enforces guest memory, stack, fuel and elapsed time, and the supervisor kills children at
their deadline or on cancellation. At most four children run per API or worker process, and
API example evaluations allow two concurrent jobs per tenant; size the worker deployment for
those aggregates. macOS arm64 supports development with guest limits and supervised
wall-time cancellation, but without `prlimit`.

## Code contract

```ts
function main(input, luma) {
  return { quantity: Math.max(0, input.inputs.target - input.evidence.stock) };
}
```

- Declare every returned scalar field. `input` holds the run's typed inputs, evidence facts
  and completed outer-step outputs. `luma.now` is the run's fixed creation time.
- Imports, exports, async entry points and package dependencies are unsupported. Real
  clocks, randomness, secrets, environment variables, files, network and connector handlers
  are unavailable. The host strips types without evaluating source; all user code runs in
  Wasm.
- A Code Step's grants name the read or capability steps immediately after it, and each
  capability keeps its immediately following verification. Those steps belong to the Code
  Step and the outer interpreter skips them. `luma.request('grant-id')` requests exactly that
  step; code cannot supply action parameters, because the domain adapter binds the
  published inputs. Only adapters that install this boundary support grants; replenishment
  does.

## Replay, approval and cancellation

The host refreshes authorization before each request. Inputs and the fixed time are bound
before the first call, and replies are journaled in order before code resumes. A retry
replays saved replies and reuses the existing action identity. Inputs and replies use
canonical JSON key order, so equivalent inputs replay identically.

Approval suspends the step and releases its sandbox; it resumes by deterministic replay.
Cancellation and deadlines stop guest execution immediately and a stopped sandbox cannot
send new requests. An in-flight host request still finishes verification and journaling,
and already admitted actions keep their reconciliation path. Previously verified actions
stay visible when code fails. Unexpected host failures retry the durable activity; expected
capability denials are terminal.

## Evidence and evaluation

Run evidence includes runtime, artifact and input hashes, returned fields, request count,
elapsed time and a filtered outcome; Linux adds sampled peak resident memory. Raw guest
errors and stderr are discarded because they may contain input values. Code output is
authorized workflow data, stored with snapshots and replies under tenant RLS; keep secrets
out of workflow inputs.

Example evaluation of a published version uses supplied capability replies and a fixed
clock, never a live adapter. Evaluation IDs bind to their complete request, so retry the
same body after an uncertain response. Results survive API restarts; jobs interrupted by a
restart expire as failed, and cancellation is visible across API instances.

`pnpm evaluate:code` is the offline replay gate. Each fixture runs twice against ordered
example replies; changed outputs, extra or missing requests and replay differences fail.
Reports omit timings so identical fixtures produce identical reports. It never dispatches
actions.

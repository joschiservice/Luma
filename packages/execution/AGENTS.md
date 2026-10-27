# @luma/execution

Action admission, the single durable dispatch reservation, attempt records and
reconciliation for every external write. Read [policy, execution and audit](../../docs/execution.md)
before changing anything here; most of its rules are safety invariants.

## Invariants that are easy to break

- One proposal, one attempt. The execution key is `v0:<proposal UUID>`. Never add a retry
  loop, a second reservation or a new proposal to retry an ambiguous write.
- Ordering: policy and prepared events reach the audit log first, transactions end, then
  the effect is called. No connector I/O inside a transaction.
- A prepared reservation starts `uncertain` and `pending`. A thrown provider call stays
  uncertain unless the adapter reports dispatch certainty explicitly.
- Reconciliation only reads. Negative or inconclusive reads keep the attempt blocked; only
  a passed fresh verification settles it. Escalate instead of redispatching.
- Observe-only records a terminal `not_executed` result before policy approval or
  reservation, and is checked again after audit persistence. Replays never redispatch it.
- Callers execute by `runId` and `stepId` only. Do not widen the input to accept
  proposals, targets, credentials or parameters from the caller.
- The installed connector runtime exposes only `read` and `discover`. Write registries
  are built in trusted composition and stay private to the engine.
- Parameters and postconditions hold minimal non-sensitive command data; audit entries
  never hold exception messages or provider payloads.

## Storage

Safety tables use forced RLS, and runtime roles cannot update or delete policy, audit or
intent records; a trigger guards attempt identity and final results. Schema changes go
through `packages/application-runtime/migrations` and must keep those grants.

## Tests

Unit tests beside the application code run admission and the execution engine over in-memory
ports with the real validators and policy evaluation: `pnpm --filter @luma/execution test`.
Storage, grants and reservation behavior are covered against PostgreSQL in
`packages/application-runtime/src/execution.integration.test.ts` and
`reservation-fence.integration.test.ts` beside it. Run them with
`pnpm run test --filter=@luma/application-runtime -- execution.integration.test.ts`, which
provisions a disposable database. A direct `pnpm --filter` run skips database suites unless
`TEST_DATABASE_URL` is set.
